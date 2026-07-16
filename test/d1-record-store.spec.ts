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
import type { ListQuery, NewRecord } from '../src/storage';
import { SEEDED_APP, SEEDED_APP_OTHER, SEEDED_INSTANCE, SEEDED_INSTANCE_OTHER, seedKeys } from './seed';

const store = () => new D1RecordStore(env.DB);

/** Installation 1. */
const WRITE: WritePrincipal = { kind: 'write', appId: SEEDED_APP, instanceId: SEEDED_INSTANCE };
const READ: ReadPrincipal = { kind: 'read', appId: SEEDED_APP, instanceId: SEEDED_INSTANCE };
/** Installation 2 — a different (app, instance) pair entirely. */
const WRITE_OTHER: WritePrincipal = { kind: 'write', appId: SEEDED_APP_OTHER, instanceId: SEEDED_INSTANCE_OTHER };
const READ_OTHER: ReadPrincipal = { kind: 'read', appId: SEEDED_APP_OTHER, instanceId: SEEDED_INSTANCE_OTHER };

const RECEIVED_AT = new Date('2026-07-15T12:00:00.000Z');
const RECEIVED_DATE = '2026-07-15';

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

    expect(await store().insert(WRITE, RECEIVED_AT, [one])).toEqual(['created']);
    expect(await store().insert(WRITE, RECEIVED_AT, [one])).toEqual(['duplicate']);
  });

  // Positional alignment is the contract handlers.ts depends on: it maps outcomes back onto the
  // submitted records by index, so a filtered or reordered array would silently mislabel records.
  it('returns outcomes aligned with the submitted records, same length and order', async () => {
    const seen = record();
    await store().insert(WRITE, RECEIVED_AT, [seen]);

    const outcomes = await store().insert(WRITE, RECEIVED_AT, [record(), seen, record()]);

    expect(outcomes).toEqual(['created', 'duplicate', 'created']);
  });

  // The spec says a batch may legitimately carry one client_id twice. Statements run sequentially
  // inside the batch's transaction, so the second must see the first rather than both inserting.
  it('deduplicates within a single batch', async () => {
    const twice = record();

    expect(await store().insert(WRITE, RECEIVED_AT, [twice, twice])).toEqual(['created', 'duplicate']);

    const { results } = await env.DB.prepare('SELECT id FROM records WHERE client_id = ?1').bind(twice.clientId).all();
    expect(results).toHaveLength(1);
  });

  // The axis instance_id-only dedupe gets wrong. Both installations are legitimately allowed to use
  // the same client_id; if the scope were anything less than the pair, the second would come back
  // `duplicate` -- an acknowledgment -- and the client would drop a record that was never stored.
  it('scopes dedupe to the installation, not to a client_id alone', async () => {
    const shared = record();

    expect(await store().insert(WRITE, RECEIVED_AT, [shared])).toEqual(['created']);
    expect(await store().insert(WRITE_OTHER, RECEIVED_AT, [shared])).toEqual(['created']);

    const { results } = await env.DB.prepare('SELECT id FROM records WHERE client_id = ?1').bind(shared.clientId).all();
    expect(results).toHaveLength(2);
  });

  it('stamps the received date from the server clock and the created date from the client', async () => {
    await store().insert(WRITE, RECEIVED_AT, [record({ createdAt: '2026-07-15T14:03:22+02:00' })]);

    const row = await env.DB.prepare('SELECT created_date, received_date FROM records').first();
    expect(row).toEqual({ created_date: '2026-07-15', received_date: RECEIVED_DATE });
  });

  // A dead RTC. The point of keeping a server-derived date is that this stays visible forever, long
  // after the metadata table's full timestamps have been cleaned away.
  it('stores a wrong exhibit clock as sent, leaving skew detectable', async () => {
    await store().insert(WRITE, RECEIVED_AT, [record({ createdAt: '1970-01-01T04:00:00+01:00' })]);

    const row = await env.DB.prepare('SELECT created_date, received_date FROM records').first();
    expect(row).toEqual({ created_date: '1970-01-01', received_date: RECEIVED_DATE });
  });

  it('stores no time of day anywhere in the row', async () => {
    await store().insert(WRITE, RECEIVED_AT, [record()]);

    const row = await env.DB.prepare('SELECT * FROM records').first<Record<string, unknown>>();
    // Nothing resembling a clock survived: not the client's 14:03:22, not the server's 12:00:00.
    expect(JSON.stringify(row)).not.toMatch(/\d{2}:\d{2}/);
  });

  it('writes one received_date for a whole batch', async () => {
    await store().insert(WRITE, RECEIVED_AT, [record(), record(), record()]);

    const { results } = await env.DB.prepare('SELECT DISTINCT received_date FROM records').all();
    expect(results).toEqual([{ received_date: RECEIVED_DATE }]);
  });

  it('stores a null content_version as SQL NULL', async () => {
    await store().insert(WRITE, RECEIVED_AT, [record({ contentVersion: null })]);

    const row = await env.DB.prepare('SELECT content_version FROM records').first();
    expect(row).toEqual({ content_version: null });
  });

  // A transient fault must never be reported per-record: `created`/`duplicate` are acknowledgments
  // and the client drops acknowledged records from its retry queue. Throwing is the only honest
  // answer, and `InsertOutcome` has no variant that could express anything else.
  it('throws rather than reporting an outcome when D1 fails', async () => {
    await env.DB.prepare('DROP TABLE records').run();

    await expect(store().insert(WRITE, RECEIVED_AT, [record()])).rejects.toThrow();
  });
});

describe('app_data', () => {
  it('round-trips an arbitrary JSON value byte-identically', async () => {
    const appData = { nodes: [['q1', 3]], consent: true, note: '🎨 ünï©ode', nested: { deep: [null, 1.5] } };
    await store().insert(WRITE, RECEIVED_AT, [record({ appDataJson: JSON.stringify(appData) })]);

    const page = await store().list(READ, query());
    expect(page.records[0].app_data).toEqual(appData);
  });

  // A JSON null is a legal app_data and means "the payload is null", which is a different fact from
  // SQL NULL ("there is no payload") -- something this protocol cannot express and must never
  // silently produce. The NOT NULL column is what makes the wrong one unspellable.
  it('round-trips a JSON null as null, not as SQL NULL', async () => {
    await store().insert(WRITE, RECEIVED_AT, [record({ appDataJson: 'null' })]);

    const row = await env.DB.prepare('SELECT app_data FROM records').first();
    expect(row).toEqual({ app_data: 'null' });

    const page = await store().list(READ, query());
    expect(page.records[0].app_data).toBeNull();
  });

  it('stores scalars and arrays, not just objects', async () => {
    await store().insert(WRITE, RECEIVED_AT, [record({ appDataJson: '42' }), record({ appDataJson: '[1,"two"]' })]);

    const page = await store().list(READ, query());
    expect(page.records.map((r) => r.app_data)).toEqual([42, [1, 'two']]);
  });
});

describe('list', () => {
  it('returns records oldest first with the installation resolved from the principal', async () => {
    await store().insert(WRITE, RECEIVED_AT, [record(), record()]);

    const page = await store().list(READ, query());

    expect(page.records.map((r) => r.id)).toEqual([...page.records.map((r) => r.id)].sort((a, b) => a - b));
    expect(page.records[0]).toMatchObject({ app_id: SEEDED_APP, instance_id: SEEDED_INSTANCE });
    expect(page.hasMore).toBe(false);
  });

  // The scope, not a filter. ListQuery deliberately carries no app or instance, so there is nothing
  // a caller could pass to widen this -- but an adapter that forgot the WHERE would hand one museum
  // another's data while every paging test still passed.
  it('never returns another installation-s records', async () => {
    await store().insert(WRITE, RECEIVED_AT, [record(), record()]);
    await store().insert(WRITE_OTHER, RECEIVED_AT, [record()]);

    expect((await store().list(READ, query())).records).toHaveLength(2);
    expect((await store().list(READ_OTHER, query())).records).toHaveLength(1);
  });

  it('pages by the cursor, exclusive of after_id', async () => {
    await store().insert(WRITE, RECEIVED_AT, [record(), record(), record()]);
    const all = (await store().list(READ, query())).records.map((r) => r.id);

    const page = await store().list(READ, query({ afterId: all[0] }));

    expect(page.records.map((r) => r.id)).toEqual([all[1], all[2]]);
  });

  it('reports hasMore from an overflow row rather than a count', async () => {
    await store().insert(WRITE, RECEIVED_AT, [record(), record(), record()]);

    const page = await store().list(READ, query({ limit: 2 }));

    expect(page.records).toHaveLength(2);
    expect(page.hasMore).toBe(true);

    const last = await store().list(READ, query({ afterId: page.records[1].id, limit: 2 }));
    expect(last.records).toHaveLength(1);
    expect(last.hasMore).toBe(false);
  });

  it('filters by engine_version and content_version within the scope', async () => {
    await store().insert(WRITE, RECEIVED_AT, [
      record({ engineVersion: 'engine-1', contentVersion: 'c1' }),
      record({ engineVersion: 'engine-2', contentVersion: 'c2' }),
    ]);

    expect((await store().list(READ, query({ engineVersion: 'engine-1' }))).records).toHaveLength(1);
    expect((await store().list(READ, query({ contentVersion: 'c2' }))).records).toHaveLength(1);
    expect((await store().list(READ, query({ engineVersion: 'engine-1', contentVersion: 'c2' }))).records).toEqual([]);
  });

  // Mirrors SQL equality, and pins it: `content_version = 'x'` is NULL -- not true -- for a row with
  // no content_version, so there is no way to filter *for* null. FakeRecordStore claims the same.
  it('never matches a null content_version against a filter value', async () => {
    await store().insert(WRITE, RECEIVED_AT, [record({ contentVersion: null })]);

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
    await store().insert(WRITE, RECEIVED_AT, [record()]);
    const first = (await store().list(READ, query())).records[0].id;

    await env.DB.prepare('DELETE FROM records WHERE id = ?1').bind(first).run();
    await store().insert(WRITE, RECEIVED_AT, [record()]);

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
