/**
 * `D1RecordStore` against a real (local) D1.
 *
 * The counterpart to `d1-key-store.spec.ts`, and it exists for the same reason: `FakeRecordStore`
 * reimplements dedupe and paging in TypeScript, so the handler specs prove the *semantics* while
 * proving nothing about the SQL. Everything here is a claim the fake cannot make — that the UNIQUE
 * constraint is the thing deduplicating, that `meta.changes` really distinguishes an insert from a
 * conflict, that a JSON null survives a TEXT column, that a D1 fault becomes a throw and not an
 * outcome.
 *
 * Note the pool rolls storage back per test, so each test seeds what it needs and nothing leaks
 * sideways. `seedKeys` runs in `beforeAll`, which the pool copies into every test's frame.
 */

import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ReadPrincipal, WritePrincipal } from '../src/auth';
import { D1RecordStore } from '../src/d1-record-store';
import type { Provenance } from '../src/provenance';
import type { ListQuery, NewRecord } from '../src/storage';
import {
  ID_READER,
  ID_READER_SAME,
  ID_WRITE,
  SEEDED_APP,
  SEEDED_APP_OTHER,
  SEEDED_INSTANCE,
  SEEDED_INSTANCE_OTHER,
  seedKeys,
} from './seed';

const store = () => new D1RecordStore(env.DB);

/** Installation 1. */
const WRITE: WritePrincipal = { kind: 'write', appId: SEEDED_APP, instanceId: SEEDED_INSTANCE, keyId: ID_WRITE };
const READ: ReadPrincipal = { kind: 'read', appId: SEEDED_APP, instanceId: SEEDED_INSTANCE, keyId: ID_READER_SAME };
/** Installation 2 — a different (app, instance) pair entirely. */
const WRITE_OTHER: WritePrincipal = { kind: 'write', appId: SEEDED_APP_OTHER, instanceId: SEEDED_INSTANCE_OTHER, keyId: ID_WRITE };
const READ_OTHER: ReadPrincipal = { kind: 'read', appId: SEEDED_APP_OTHER, instanceId: SEEDED_INSTANCE_OTHER, keyId: ID_READER };

const RECEIVED_AT = new Date('2026-07-15T12:00:00.000Z');
const RECEIVED_DATE = '2026-07-15';
/** `RECEIVED_AT` as the log stores it — the precision `records` throws away. */
const RECEIVED_AT_ISO = '2026-07-15T12:00:00.000Z';

const SUBMISSION_ID = '5c7e0000-0000-4000-8000-00000000ffff';

/**
 * Every field populated, so a column the adapter forgot to bind shows up as a null rather than
 * matching a fixture that was null anyway. Tests about *absent* geo override explicitly.
 */
const provenance = (overrides: Partial<Provenance> = {}): Provenance => ({
  submissionId: SUBMISSION_ID,
  clientIp: '203.0.113.9',
  userAgent: 'nachbarin-engine/1.4.2',
  country: 'DE',
  city: 'Munich',
  asn: 3320,
  asOrganization: 'Deutsche Telekom AG',
  colo: 'FRA',
  timezone: 'Europe/Berlin',
  ...overrides,
});

let counter = 0;
/** Deterministic — `crypto.randomUUID` would make a failure unreproducible. */
const uuid = () => `3f8a0000-0000-4000-8000-${(++counter).toString(16).padStart(12, '0')}`;

function record(overrides: Partial<NewRecord> = {}): NewRecord {
  return {
    clientId: uuid(),
    createdAt: '2026-07-15T14:03:22+02:00',
    engineVersion: 'engine-1.4.2',
    contentVersion: 'sha256:ab12cd34',
    appDataJson: '{"nodes":[["q1",3]]}',
    ...overrides,
  };
}

const query = (overrides: Partial<ListQuery> = {}): ListQuery => ({
  afterId: 0,
  limit: 100,
  engineVersion: null,
  contentVersion: null,
  ...overrides,
});

beforeAll(seedKeys);

describe('insert', () => {
  it('reports created for a new record and duplicate for a resend', async () => {
    const one = record();

    expect(await store().insert(WRITE, RECEIVED_AT, [one], provenance())).toEqual(['created']);
    expect(await store().insert(WRITE, RECEIVED_AT, [one], provenance())).toEqual(['duplicate']);
  });

  // Positional alignment is the contract handlers.ts depends on: it maps outcomes back onto the
  // submitted records by index, so a filtered or reordered array would silently mislabel records.
  it('returns outcomes aligned with the submitted records, same length and order', async () => {
    const seen = record();
    await store().insert(WRITE, RECEIVED_AT, [seen], provenance());

    const outcomes = await store().insert(WRITE, RECEIVED_AT, [record(), seen, record()], provenance());

    expect(outcomes).toEqual(['created', 'duplicate', 'created']);
  });

  // The spec says a batch may legitimately carry one client_id twice. Statements run sequentially
  // inside the batch's transaction, so the second must see the first rather than both inserting.
  it('deduplicates within a single batch', async () => {
    const twice = record();

    expect(await store().insert(WRITE, RECEIVED_AT, [twice, twice], provenance())).toEqual(['created', 'duplicate']);

    const { results } = await env.DB.prepare('SELECT id FROM records WHERE client_id = ?1').bind(twice.clientId).all();
    expect(results).toHaveLength(1);
  });

  // The axis instance_id-only dedupe gets wrong. Both installations are legitimately allowed to use
  // the same client_id; if the scope were anything less than the pair, the second would come back
  // `duplicate` -- an acknowledgment -- and the client would drop a record that was never stored.
  it('scopes dedupe to the installation, not to a client_id alone', async () => {
    const shared = record();

    expect(await store().insert(WRITE, RECEIVED_AT, [shared], provenance())).toEqual(['created']);
    expect(await store().insert(WRITE_OTHER, RECEIVED_AT, [shared], provenance())).toEqual(['created']);

    const { results } = await env.DB.prepare('SELECT id FROM records WHERE client_id = ?1').bind(shared.clientId).all();
    expect(results).toHaveLength(2);
  });

  it('stamps the received date from the server clock and the created date from the client', async () => {
    await store().insert(WRITE, RECEIVED_AT, [record({ createdAt: '2026-07-15T14:03:22+02:00' })], provenance());

    const row = await env.DB.prepare('SELECT created_date, received_date FROM records').first();
    expect(row).toEqual({ created_date: '2026-07-15', received_date: RECEIVED_DATE });
  });

  // A dead RTC. The point of keeping a server-derived date is that this stays visible forever, long
  // after the submission log's full timestamps have been swept away.
  it('stores a wrong exhibit clock as sent, leaving skew detectable', async () => {
    await store().insert(WRITE, RECEIVED_AT, [record({ createdAt: '1970-01-01T04:00:00+01:00' })], provenance());

    const row = await env.DB.prepare('SELECT created_date, received_date FROM records').first();
    expect(row).toEqual({ created_date: '1970-01-01', received_date: RECEIVED_DATE });
  });

  it('stores no time of day anywhere in the row', async () => {
    await store().insert(WRITE, RECEIVED_AT, [record()], provenance());

    const row = await env.DB.prepare('SELECT * FROM records').first<Record<string, unknown>>();
    // Nothing resembling a clock survived: not the client's 14:03:22, not the server's 12:00:00.
    expect(JSON.stringify(row)).not.toMatch(/\d{2}:\d{2}/);
  });

  it('writes one received_date for a whole batch', async () => {
    await store().insert(WRITE, RECEIVED_AT, [record(), record(), record()], provenance());

    const { results } = await env.DB.prepare('SELECT DISTINCT received_date FROM records').all();
    expect(results).toEqual([{ received_date: RECEIVED_DATE }]);
  });

  it('stores a null content_version as SQL NULL', async () => {
    await store().insert(WRITE, RECEIVED_AT, [record({ contentVersion: null })], provenance());

    const row = await env.DB.prepare('SELECT content_version FROM records').first();
    expect(row).toEqual({ content_version: null });
  });

  // A transient fault must never be reported per-record: `created`/`duplicate` are acknowledgments
  // and the client drops acknowledged records from its retry queue. Throwing is the only honest
  // answer, and `InsertOutcome` has no variant that could express anything else.
  it('throws rather than reporting an outcome when D1 fails', async () => {
    await env.DB.prepare('DROP TABLE records').run();

    await expect(store().insert(WRITE, RECEIVED_AT, [record()], provenance())).rejects.toThrow();
  });
});

describe('app_data', () => {
  it('round-trips an arbitrary JSON value byte-identically', async () => {
    const appData = { nodes: [['q1', 3]], consent: true, note: '🎨 ünï©ode', nested: { deep: [null, 1.5] } };
    await store().insert(WRITE, RECEIVED_AT, [record({ appDataJson: JSON.stringify(appData) })], provenance());

    const page = await store().list(READ, query());
    expect(page.records[0].app_data).toEqual(appData);
  });

  // A JSON null is a legal app_data and means "the payload is null", which is a different fact from
  // SQL NULL ("there is no payload") -- something this protocol cannot express and must never
  // silently produce. The NOT NULL column is what makes the wrong one unspellable.
  it('round-trips a JSON null as null, not as SQL NULL', async () => {
    await store().insert(WRITE, RECEIVED_AT, [record({ appDataJson: 'null' })], provenance());

    const row = await env.DB.prepare('SELECT app_data FROM records').first();
    expect(row).toEqual({ app_data: 'null' });

    const page = await store().list(READ, query());
    expect(page.records[0].app_data).toBeNull();
  });

  it('stores scalars and arrays, not just objects', async () => {
    await store().insert(WRITE, RECEIVED_AT, [record({ appDataJson: '42' }), record({ appDataJson: '[1,"two"]' })], provenance());

    const page = await store().list(READ, query());
    expect(page.records.map((r) => r.app_data)).toEqual([42, [1, 'two']]);
  });
});

describe('list', () => {
  it('returns records oldest first with the installation resolved from the principal', async () => {
    await store().insert(WRITE, RECEIVED_AT, [record(), record()], provenance());

    const page = await store().list(READ, query());

    expect(page.records.map((r) => r.id)).toEqual([...page.records.map((r) => r.id)].sort((a, b) => a - b));
    expect(page.records[0]).toMatchObject({ app_id: SEEDED_APP, instance_id: SEEDED_INSTANCE });
    expect(page.hasMore).toBe(false);
  });

  // The scope, not a filter. ListQuery deliberately carries no app or instance, so there is nothing
  // a caller could pass to widen this -- but an adapter that forgot the WHERE would hand one museum
  // another's data while every paging test still passed.
  it('never returns another installation-s records', async () => {
    await store().insert(WRITE, RECEIVED_AT, [record(), record()], provenance());
    await store().insert(WRITE_OTHER, RECEIVED_AT, [record()], provenance());

    expect((await store().list(READ, query())).records).toHaveLength(2);
    expect((await store().list(READ_OTHER, query())).records).toHaveLength(1);
  });

  it('pages by the cursor, exclusive of after_id', async () => {
    await store().insert(WRITE, RECEIVED_AT, [record(), record(), record()], provenance());
    const all = (await store().list(READ, query())).records.map((r) => r.id);

    const page = await store().list(READ, query({ afterId: all[0] }));

    expect(page.records.map((r) => r.id)).toEqual([all[1], all[2]]);
  });

  it('reports hasMore from an overflow row rather than a count', async () => {
    await store().insert(WRITE, RECEIVED_AT, [record(), record(), record()], provenance());

    const page = await store().list(READ, query({ limit: 2 }));

    expect(page.records).toHaveLength(2);
    expect(page.hasMore).toBe(true);

    const last = await store().list(READ, query({ afterId: page.records[1].id, limit: 2 }));
    expect(last.records).toHaveLength(1);
    expect(last.hasMore).toBe(false);
  });

  it('filters by engine_version and content_version within the scope', async () => {
    await store().insert(
      WRITE,
      RECEIVED_AT,
      [record({ engineVersion: 'engine-1', contentVersion: 'c1' }), record({ engineVersion: 'engine-2', contentVersion: 'c2' })],
      provenance(),
    );

    expect((await store().list(READ, query({ engineVersion: 'engine-1' }))).records).toHaveLength(1);
    expect((await store().list(READ, query({ contentVersion: 'c2' }))).records).toHaveLength(1);
    expect((await store().list(READ, query({ engineVersion: 'engine-1', contentVersion: 'c2' }))).records).toEqual([]);
  });

  // Mirrors SQL equality, and pins it: `content_version = 'x'` is NULL -- not true -- for a row with
  // no content_version, so there is no way to filter *for* null. FakeRecordStore claims the same.
  it('never matches a null content_version against a filter value', async () => {
    await store().insert(WRITE, RECEIVED_AT, [record({ contentVersion: null })], provenance());

    expect((await store().list(READ, query({ contentVersion: 'anything' }))).records).toEqual([]);
    expect((await store().list(READ, query())).records).toHaveLength(1);
  });

  it('returns an empty page rather than failing when there is nothing to send', async () => {
    const page = await store().list(READ, query());

    expect(page.records).toEqual([]);
    expect(page.hasMore).toBe(false);
  });

  it('throws when D1 fails', async () => {
    await env.DB.prepare('DROP TABLE records').run();

    await expect(store().list(READ, query())).rejects.toThrow();
  });
});

describe('the schema backs the adapter up', () => {
  // The cursor is the download contract. Without AUTOINCREMENT, SQLite reuses the rowid of a deleted
  // highest row, and a reader already past that id would never see the record that took its place --
  // no error, both sides believing the transfer was complete. Deletes are not hypothetical here:
  // vandalism cleanup and erasure requests are exactly what this table expects.
  it('never reuses an id after the highest record is deleted', async () => {
    await store().insert(WRITE, RECEIVED_AT, [record()], provenance());
    const first = (await store().list(READ, query())).records[0].id;

    await env.DB.prepare('DELETE FROM records WHERE id = ?1').bind(first).run();
    await store().insert(WRITE, RECEIVED_AT, [record()], provenance());

    const page = await store().list(READ, query());
    expect(page.records[0].id).toBeGreaterThan(first);
  });

  // Validation lowercases client_id, but this table is reachable by hand too. BINARY collation makes
  // an uppercase UUID a different string, so without the CHECK the same record could be stored twice
  // under two spellings and the UNIQUE would never fire.
  it('rejects a client_id that is not canonical lowercase', async () => {
    const insert = env.DB.prepare(
      `INSERT INTO records (installation_pk, client_id, created_date, received_date, engine_version, app_data)
       VALUES (1, ?1, '2026-07-15', '2026-07-15', 'e', '1')`,
    );

    await expect(insert.bind('3F8A0000-0000-4000-8000-00000000000A').run()).rejects.toThrow();
  });

  // Pages are ordered by id, so a reader cannot step over a row it cannot parse: one bad row would
  // wedge that installation's download at that cursor permanently. The CHECK is what makes the
  // JSON.parse in the adapter safe.
  it('rejects app_data that is not valid JSON', async () => {
    const insert = env.DB.prepare(
      `INSERT INTO records (installation_pk, client_id, created_date, received_date, engine_version, app_data)
       VALUES (1, ?1, '2026-07-15', '2026-07-15', 'e', ?2)`,
    );

    await expect(insert.bind(uuid(), 'not json').run()).rejects.toThrow();
  });

  it('rejects a date that carries a time', async () => {
    const insert = env.DB.prepare(
      `INSERT INTO records (installation_pk, client_id, created_date, received_date, engine_version, app_data)
       VALUES (1, ?1, ?2, '2026-07-15', 'e', '1')`,
    );

    await expect(insert.bind(uuid(), '2026-07-15T14:03:22+02:00').run()).rejects.toThrow();
  });

  it('refuses to orphan a record from its installation', async () => {
    const insert = env.DB.prepare(
      `INSERT INTO records (installation_pk, client_id, created_date, received_date, engine_version, app_data)
       VALUES (?1, ?2, '2026-07-15', '2026-07-15', 'e', '1')`,
    );

    await expect(insert.bind(9999, uuid()).run()).rejects.toThrow();
  });
});

/** One log row, as SQL hands it back. */
interface SubmissionRow {
  submission_id: string;
  installation_pk: number;
  key_id: number;
  client_id: string;
  created_at: string;
  received_at: string;
  client_ip: string | null;
  user_agent: string | null;
  cf_country: string | null;
  cf_city: string | null;
  cf_asn: number | null;
  cf_as_organization: string | null;
  cf_colo: string | null;
  cf_timezone: string | null;
}

const submissions = async (): Promise<SubmissionRow[]> => {
  const { results } = await env.DB.prepare('SELECT * FROM record_submissions ORDER BY id').all<SubmissionRow>();
  return results;
};

describe('the submission log', () => {
  // The assertion that separates the two possible grains, and the reason this table is a log rather
  // than metadata hanging off records.id. A resubmission stores no record -- ON CONFLICT DO NOTHING
  // -- so under a 1:1 design it leaves no trace at all, and a queue that has stopped draining, or a
  // batch replayed from somewhere else, is invisible.
  it('logs a row for a duplicate, which stores no record', async () => {
    const one = record();

    await store().insert(WRITE, RECEIVED_AT, [one], provenance({ submissionId: uuid() }));
    await store().insert(WRITE, RECEIVED_AT, [one], provenance({ submissionId: uuid() }));

    const { results } = await env.DB.prepare('SELECT id FROM records WHERE client_id = ?1').bind(one.clientId).all();
    expect(results).toHaveLength(1);

    const logged = await submissions();
    expect(logged).toHaveLength(2);
    // Two submissions of one client_id, distinguishable -- which is the whole point.
    expect(new Set(logged.map((row) => row.submission_id)).size).toBe(2);
  });

  it('logs one row per submitted record, sharing the submission id', async () => {
    await store().insert(WRITE, RECEIVED_AT, [record(), record(), record()], provenance({ submissionId: SUBMISSION_ID }));

    const logged = await submissions();
    expect(logged).toHaveLength(3);
    expect(logged.map((row) => row.submission_id)).toEqual([SUBMISSION_ID, SUBMISSION_ID, SUBMISSION_ID]);
  });

  // The claim `records` structurally cannot make, and this table's whole reason to exist. Not merely
  // "a timestamp is present": byte-identical, with the +02:00 intact. A store that normalized to UTC
  // would still look plausible here and would have destroyed the only thing worth keeping.
  it('stores created_at verbatim, offset and all', async () => {
    const createdAt = '2026-07-15T14:03:22.318+02:00';
    await store().insert(WRITE, RECEIVED_AT, [record({ createdAt })], provenance());

    const [row] = await submissions();
    expect(row.created_at).toBe(createdAt);
    // And the coarse copy in `records` is a prefix of it -- SQLite cannot express a cross-table
    // CHECK, so this pairing is carried here instead.
    const coarse = await env.DB.prepare('SELECT created_date FROM records').first<{ created_date: string }>();
    expect(coarse?.created_date).toBe(createdAt.slice(0, 10));
  });

  it('stores received_at at full precision', async () => {
    await store().insert(WRITE, RECEIVED_AT, [record()], provenance());

    const [row] = await submissions();
    expect(row.received_at).toBe(RECEIVED_AT_ISO);
  });

  it('records which key wrote the record, and which installation', async () => {
    await store().insert(WRITE, RECEIVED_AT, [record()], provenance());

    const [row] = await submissions();
    expect(row.key_id).toBe(ID_WRITE);
    expect(row.installation_pk).toBe(1);
  });

  it('stores every provenance field the edge supplied', async () => {
    await store().insert(WRITE, RECEIVED_AT, [record()], provenance());

    const [row] = await submissions();
    expect(row).toMatchObject({
      client_ip: '203.0.113.9',
      user_agent: 'nachbarin-engine/1.4.2',
      cf_country: 'DE',
      cf_city: 'Munich',
      cf_asn: 3320,
      cf_as_organization: 'Deutsche Telekom AG',
      cf_colo: 'FRA',
      cf_timezone: 'Europe/Berlin',
    });
  });

  // request.cf is absent in local dev and under test, so this is the *normal* case rather than an
  // edge one. A null must arrive as SQL NULL: the strings 'null' or 'undefined' would be data, and
  // `WHERE cf_country IS NULL` would then quietly miss every row it exists to find.
  it('stores absent edge data as SQL NULL, never as a string', async () => {
    const nothing = provenance({
      clientIp: null,
      userAgent: null,
      country: null,
      city: null,
      asn: null,
      asOrganization: null,
      colo: null,
      timezone: null,
    });

    await store().insert(WRITE, RECEIVED_AT, [record()], nothing);

    const [row] = await submissions();
    expect(row).toMatchObject({
      client_ip: null,
      user_agent: null,
      cf_country: null,
      cf_city: null,
      cf_asn: null,
      cf_as_organization: null,
      cf_colo: null,
      cf_timezone: null,
    });
  });

  // The test a separate MetadataStore could not pass, and the reason `insert` takes provenance as a
  // parameter instead. Both writes are in one batch, so one transaction: a record must never exist
  // without the row describing where it came from.
  it('rolls the records back when the log write fails', async () => {
    await env.DB.prepare('DROP TABLE record_submissions').run();

    await expect(store().insert(WRITE, RECEIVED_AT, [record(), record()], provenance())).rejects.toThrow();

    const { results } = await env.DB.prepare('SELECT id FROM records').all();
    expect(results).toHaveLength(0);
  });

  it('throws when D1 fails', async () => {
    await env.DB.prepare('DROP TABLE record_submissions').run();

    await expect(store().insert(WRITE, RECEIVED_AT, [record()], provenance())).rejects.toThrow();
  });
});

describe('the submission log schema', () => {
  const insertLog = (columns: string, values: string) =>
    env.DB.prepare(`INSERT INTO record_submissions (submission_id, installation_pk, key_id, client_id, ${columns})
       VALUES (?1, 1, ${String(ID_WRITE)}, ?2, ${values})`);

  // The trap this whole table's CHECK design exists to avoid. RFC3339_RE accepts a lowercase 't' and
  // 'z', and validateCreatedAt returns the string verbatim -- so this is a record the API accepts
  // today. GLOB is case-sensitive: a literal 'T' in the CHECK would roll back the batch, 500, and
  // wedge that client forever, because these rows share the records' transaction.
  //
  // If someone "tidies" the GLOB to a literal T, this is the test that stops them.
  it('accepts a lowercase t/z created_at, which validation accepts', async () => {
    const insert = insertLog('created_at, received_at', `?3, '${RECEIVED_AT_ISO}'`);

    await expect(insert.bind(uuid(), uuid(), '2026-07-15t14:03:22z').run()).resolves.toBeTruthy();
  });

  // The regex allows unbounded fractional digits, so the CHECK must not bound the length.
  it('accepts unbounded fractional seconds, which validation accepts', async () => {
    const insert = insertLog('created_at, received_at', `?3, '${RECEIVED_AT_ISO}'`);

    await expect(insert.bind(uuid(), uuid(), '2026-07-15T14:03:22.123456789+02:00').run()).resolves.toBeTruthy();
  });

  // Half the join key back to `records`. Comparison is BINARY, so an uppercase spelling joins to
  // nothing -- and a broken join does not raise, it just returns fewer rows. Same CHECK as
  // records.client_id, guarding a quieter failure.
  it('rejects a client_id that is not canonical lowercase', async () => {
    const insert = insertLog('created_at, received_at', `'2026-07-15T14:03:22+02:00', '${RECEIVED_AT_ISO}'`);

    await expect(insert.bind(uuid(), '3F8A0000-0000-4000-8000-00000000000A').run()).rejects.toThrow();
  });

  // The half of the affinity story that needs no defending, pinned so the CHECK is not "fixed" into
  // rejecting it: INTEGER affinity *converts* a well-formed integer literal, so '3320' is stored as
  // the integer 3320 and queries find it. A CHECK that rejected this would be rejecting a value the
  // database was about to get right.
  it('converts a well-formed integer literal for cf_asn rather than rejecting it', async () => {
    const insert = insertLog('created_at, received_at, cf_asn', `'2026-07-15T14:03:22+02:00', '${RECEIVED_AT_ISO}', ?3`);
    await insert.bind(uuid(), uuid(), '3320').run();

    const row = await env.DB.prepare(`SELECT typeof(cf_asn) AS t FROM record_submissions WHERE cf_asn = 3320`).first<{ t: string }>();
    expect(row?.t).toBe('integer');
  });

  // The half that does. Affinity will not touch a value that is not a well-formed integer literal:
  // 'AS3320' stays TEXT, a float stays REAL, and an int64 overflow silently becomes REAL. Each sits
  // in the column looking like an ASN while comparing equal to no integer at all, so `WHERE cf_asn =
  // 3320` finds nothing and says nothing. typeof() is the only construct that sees this -- the same
  // shape of argument 0001 makes about VARCHAR(100) not enforcing 100.
  it.each([
    ['text that is not a number', 'AS3320'],
    ['a float', 3320.5],
    ['an integer too large for 64 bits', '9999999999999999999999'],
  ])('rejects a cf_asn stored as %s', async (_label, value) => {
    const insert = insertLog('created_at, received_at, cf_asn', `'2026-07-15T14:03:22+02:00', '${RECEIVED_AT_ISO}', ?3`);

    await expect(insert.bind(uuid(), uuid(), value).run()).rejects.toThrow();
  });

  it('rejects a received_at that is not toISOString output', async () => {
    const insert = insertLog('created_at, received_at', `'2026-07-15T14:03:22+02:00', ?3`);

    // No milliseconds: sorts the same, but is not what the sweep's fixed-width comparison assumes.
    await expect(insert.bind(uuid(), uuid(), '2026-07-15T12:00:00Z').run()).rejects.toThrow();
  });

  // Not UNIQUE, deliberately -- see the index comment in 0004. If this ever starts throwing, the log
  // has silently become a 1:1 table and every retry is being rolled back into a 500.
  it('allows one client_id to be logged twice for an installation', async () => {
    const insert = insertLog('created_at, received_at', `'2026-07-15T14:03:22+02:00', '${RECEIVED_AT_ISO}'`);
    const clientId = uuid();

    await insert.bind(uuid(), clientId).run();
    await expect(insert.bind(uuid(), clientId).run()).resolves.toBeTruthy();
  });

  // Pins the constraint that shaped every format CHECK in 0004, because nothing else would notice it
  // moving. D1 caps a GLOB *pattern* at 50 bytes where stock SQLite allows 50,000, and `[0-9]` costs
  // five of them — so ten character classes is the whole budget.
  //
  // The reason this is a test and not a comment: the limit is enforced when the pattern is
  // evaluated, not when it is compiled, so `migrations apply` accepts a CHECK that can never pass and
  // the failure surfaces at the first INSERT. On this table that is the permanent-500 wedge, caused
  // by the very constraint written to prevent it. If D1 ever raises the cap, this test fails and the
  // substr() splitting in 0004 can be simplified on purpose rather than by guess.
  it('caps a GLOB pattern at 50 bytes, which is why the timestamp CHECKs are split', async () => {
    const glob = (pattern: string) => env.DB.prepare('SELECT ?1 GLOB ?2 AS m').bind('1'.repeat(10), pattern).first();

    // Ten classes, 50 bytes: the largest pattern D1 will evaluate.
    await expect(glob('[0-9]'.repeat(10))).resolves.toBeTruthy();
    // Eleven, 55 bytes.
    await expect(glob('[0-9]'.repeat(11))).rejects.toThrow(/pattern too complex/);
  });

  it('refuses to orphan a log row from its installation or its key', async () => {
    const orphanInstallation = env.DB.prepare(
      `INSERT INTO record_submissions (submission_id, installation_pk, key_id, client_id, created_at, received_at)
       VALUES (?1, 9999, ${String(ID_WRITE)}, ?2, '2026-07-15T14:03:22+02:00', '${RECEIVED_AT_ISO}')`,
    );
    await expect(orphanInstallation.bind(uuid(), uuid()).run()).rejects.toThrow();

    const orphanKey = env.DB.prepare(
      `INSERT INTO record_submissions (submission_id, installation_pk, key_id, client_id, created_at, received_at)
       VALUES (?1, 1, 9999, ?2, '2026-07-15T14:03:22+02:00', '${RECEIVED_AT_ISO}')`,
    );
    await expect(orphanKey.bind(uuid(), uuid()).run()).rejects.toThrow();
  });
});
