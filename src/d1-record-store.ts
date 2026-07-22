/**
 * D1 adapter for {@link RecordStore}.
 *
 * The other half of the persistence boundary, alongside `d1-key-store.ts`.
 *
 * This adapter is where records get coarsened *and* where the precision is kept — the two are one
 * transaction, and that is the whole point. `records` takes only the dates of `createdAt` and
 * `receivedAt`; `record_submissions` takes them whole, along with what the edge knew about the
 * request, behind different privileges and a 90-day sweep. `docs/database.md` holds the design.
 *
 * Splitting those into two adapters would split them across transactions, which is the one thing
 * neither table can afford. See {@link RecordStore.insert}.
 */

import type { ReadPrincipal, WritePrincipal } from './auth';
import { MAX_SUBMISSIONS_PER_RECORD } from './config';
import type { Provenance } from './provenance';
import type { InsertOutcome, ListPage, ListQuery, NewRecord, RecordStore, StoredRecord } from './storage';
import { localDateOf } from './validation';

/**
 * One record, deduplicated by the schema rather than by a preceding SELECT.
 *
 * `ON CONFLICT DO NOTHING` against `UNIQUE (installation_pk, client_id)` makes "have we seen this
 * already?" a single atomic statement. A read-then-write would be a race: two retries of the same
 * batch arriving together would both see nothing and both insert. Here the second simply changes no
 * rows, and {@link D1RecordStore.insert} reads the outcome off `meta.changes`.
 *
 * The installation is resolved by scalar subquery rather than passed in. `Principal` carries the
 * business pair (app_id, instance_id) and deliberately not a schema surrogate, and `UNIQUE (app_id,
 * instance_id)` makes this an index lookup that the planner evaluates once per statement. If it
 * finds nothing the NOT NULL fails loudly rather than inventing a row — which can happen in exactly
 * one way: the key resolved against that very installation moments ago, so only an operator renaming
 * the pair (`installation edit`) between this request's auth and its batch lands here. The loud
 * failure is right for that too — 500, the client retries, and the retry resolves the new name.
 */
const INSERT_SQL = `
  INSERT INTO records (installation_pk, client_id, created_date, received_date, engine_version, content_version, app_data)
  VALUES ((SELECT id FROM installations WHERE app_id = ?1 AND instance_id = ?2), ?3, ?4, ?5, ?6, ?7, ?8)
  ON CONFLICT (installation_pk, client_id) DO NOTHING
`;

/**
 * The provenance of one submitted record: the full timestamps and what the edge knew.
 *
 * Two absences are the design. **No ON CONFLICT** and no unique key to conflict against: one row
 * per submission of a client_id, so a retry writes a second row and the repetition is the signal.
 * **No record_id**: the row is keyed by `(installation_pk, client_id)`, the same natural key
 * `records` deduplicates on, which keeps this statement independent of the insert above. Keying by
 * `records.id` would need it back from an `ON CONFLICT DO NOTHING` that returns nothing on
 * conflict, forcing either a stale `meta.last_row_id` (wrong, silently) or a RETURNING in a second
 * `batch()` — outside this transaction, where a failure commits the records and loses their
 * provenance forever.
 *
 * The installation subquery is the same pattern, and the same reasoning, as {@link INSERT_SQL}.
 *
 * ## The cap: a `WHERE`, never a CHECK
 *
 * `?16` is {@link MAX_SUBMISSIONS_PER_RECORD}; its comment holds why a bound exists at all. The
 * shape:
 *
 *   * **It cannot be a CHECK, and must not be.** These rows share the record insert's transaction,
 *     so a CHECK that fires is not a rejected log row — it is a rolled-back batch, a 500, a retry,
 *     another 500, forever. A `WHERE` that excludes inserts zero rows and commits. (SQLite would
 *     refuse the CHECK regardless: no subqueries.)
 *   * **No extra query, no extra round trip.** Folded into the statement that was already being
 *     sent — still one statement per record per table inside the one `batch()`.
 *   * **The cap bounds its own cost.** The COUNT is served by `record_submissions_by_record`
 *     `(installation_pk, client_id)`, which with the cap in force holds at most `?16` entries per
 *     record; on the happy path — a client_id nobody has sent before — it is an index seek that
 *     finds nothing.
 *   * **It can only ever drop a duplicate's row, never a created record's.** Reaching the cap means
 *     the record exists, so the statement above it is a no-op and "both, or neither" holds for
 *     every stored record. One silent exception: log rows outlive their records (no FK to `records`
 *     — see `docs/database.md`), so deleting a record and then getting its client_id resubmitted
 *     while the cap's worth of log rows survives recreates the record with no provenance row. The
 *     nightly reset means the delete and the storm must fall on the same day for this to be
 *     reachable at all.
 *
 * `VALUES` cannot carry a `WHERE`, hence `SELECT` (no `FROM`: one row, or none when the `WHERE` is
 * false). A missing installation still fails loudly rather than skipping quietly: the scalar
 * subquery is NULL, the COUNT is 0, and the row trips NOT NULL exactly as it does in
 * {@link INSERT_SQL}.
 */
const INSERT_SUBMISSION_SQL = `
  INSERT INTO record_submissions (
    submission_id, installation_pk, key_id, client_id, created_at, received_at,
    client_ip, user_agent, cf_country, cf_city, cf_asn, cf_as_organization, cf_colo, cf_timezone
  )
  SELECT
    ?1, (SELECT id FROM installations WHERE app_id = ?2 AND instance_id = ?3), ?4, ?5, ?6, ?7,
    ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15
  WHERE (
    SELECT COUNT(*) FROM record_submissions
    WHERE installation_pk = (SELECT id FROM installations WHERE app_id = ?2 AND instance_id = ?3)
      AND client_id = ?5
  ) < ?16
`;

/**
 * One page, oldest first, constrained to the caller's installation.
 *
 * The installation is the first thing in the WHERE clause and comes from the principal, never from
 * `query`: a read key sees its own installation and there is no parameter that could widen that.
 *
 * No join back to `installations`, even though `app_id` and `instance_id` are on the wire. Every row
 * this returns belongs to the principal's installation by construction, so the strings are already
 * in hand — scoping by the principal is what avoids the join on every read that the surrogate key
 * would otherwise cost.
 *
 * `(?4 IS NULL OR engine_version = ?4)` is "no filter, or this filter". Note the NULL row case falls
 * out correctly for free: `content_version = 'x'` is NULL — not true — for a row whose
 * content_version is NULL, so a record without one never matches a filter *for* one.
 *
 * The ORDER BY and the cursor are served by `records_by_installation (installation_pk, id)` as a
 * covering-index range scan; no sort, no table lookup.
 */
const LIST_SQL = `
  SELECT id, client_id, created_date, received_date, engine_version, content_version, app_data
  FROM records
  WHERE installation_pk = (SELECT id FROM installations WHERE app_id = ?1 AND instance_id = ?2)
    AND id > ?3
    AND (?4 IS NULL OR engine_version = ?4)
    AND (?5 IS NULL OR content_version = ?5)
  ORDER BY id
  LIMIT ?6
`;

/** The columns {@link D1RecordStore.list} reads. `app_data` is text; the caller parses it. */
interface RecordRow {
  readonly id: number;
  readonly client_id: string;
  readonly created_date: string;
  readonly received_date: string;
  readonly engine_version: string;
  readonly content_version: string | null;
  readonly app_data: string;
}

export class D1RecordStore implements RecordStore {
  constructor(private readonly db: D1Database) {}

  async insert(
    principal: WritePrincipal,
    receivedAt: Date,
    records: readonly NewRecord[],
    provenance: Provenance,
  ): Promise<InsertOutcome[]> {
    // One date for the whole batch, in UTC because it is the server's clock. `created_date` is local
    // instead; the two are not comparable to the day, only to the order of magnitude. See
    // `StoredRecord.received_date`.
    const receivedDate = receivedAt.toISOString().slice(0, 10);
    // The same instant the dates above were cut from, kept whole for the log. Fixed-width RFC 3339
    // UTC, which is what makes the retention sweep's lexicographic comparison exact.
    const receivedAtIso = receivedAt.toISOString();

    const insertRecord = this.db.prepare(INSERT_SQL);
    const insertSubmission = this.db.prepare(INSERT_SUBMISSION_SQL);

    // One statement per record per table, never a multi-row VALUES: D1 caps a query at 100 bound
    // parameters, per *statement* within a batch rather than per batch, so 200 statements of 8 and
    // 16 parameters have vast headroom while one of 800 does not. (Chunking a multi-row VALUES to
    // fit would make the chunk size a silent function of the column count.) `batch` sends them in
    // one round trip regardless.
    //
    // The log statements are appended, deliberately not interleaved: two runs of N keep the record
    // outcomes at their own indices, where `[rec, sub, rec, sub, …]` would make `results[2i]` a
    // decoding step that goes silently wrong the first time someone reorders the array.
    //
    // No try/catch, for the reason set out in `d1-key-store.ts`: a failure here must reach the
    // error boundary in `app.ts` as a 500. `InsertOutcome` has no failure variant precisely so that
    // this is the only way out — reporting a transient fault as a per-record outcome would have the
    // client treat it as acknowledged and drop the record from its retry queue.
    //
    // `batch` is also a transaction, so a fault rolls the whole batch back and the client retries it
    // whole — which `client_id` makes safe. That is also what keeps a record and its provenance from
    // ever existing apart: both, or neither. The cap in {@link INSERT_SUBMISSION_SQL} does not weaken
    // that — it can only ever withhold a row from a submission that stored nothing — and the single
    // exception is named there.
    const results = await this.db.batch([
      ...records.map((record) =>
        insertRecord.bind(
          principal.appId,
          principal.instanceId,
          record.clientId,
          localDateOf(record.createdAt),
          receivedDate,
          record.engineVersion,
          record.contentVersion,
          record.appDataJson,
        ),
      ),
      // One row per submitted record, whether or not the statement above stored it, until this
      // client_id has {@link MAX_SUBMISSIONS_PER_RECORD} of them. A record that comes back
      // `duplicate` still arrived, from somewhere, at some time — the event this table exists to
      // see.
      ...records.map((record) =>
        insertSubmission.bind(
          provenance.submissionId,
          principal.appId,
          principal.instanceId,
          principal.keyId,
          record.clientId,
          // Verbatim: the offset is preserved, never normalized to UTC. `records.created_date` is a
          // slice of this same string, which is what makes that date local without any timezone
          // being configured anywhere.
          record.createdAt,
          receivedAtIso,
          provenance.clientIp,
          provenance.userAgent,
          provenance.country,
          provenance.city,
          provenance.asn,
          provenance.asOrganization,
          provenance.colo,
          provenance.timezone,
          // Bound rather than interpolated: a trusted integer, so hygiene rather than safety — it
          // keeps the statement a constant string.
          MAX_SUBMISSIONS_PER_RECORD,
        ),
      ),
    ]);

    // `batch` returns one result per statement in order, and the record statements are the first
    // `records.length` of them — the positional alignment the contract promises. `handlers.ts`
    // indexes this against the submitted records and would silently mismatch if it were filtered or
    // reordered.
    //
    // `changes` is the whole verdict: `ON CONFLICT DO NOTHING` inserts nothing on a conflict, so 0
    // means the (installation, client_id) was already there. A batch that legitimately carries one
    // client_id twice also comes out right — statements run sequentially inside the transaction, so
    // the second sees the first and reports `duplicate`.
    return records.map((_, i) => (results[i].meta.changes === 1 ? 'created' : 'duplicate'));
  }

  async list(principal: ReadPrincipal, query: ListQuery): Promise<ListPage> {
    // Fetch one more than asked for: if it comes back, records exist beyond this page. A COUNT(*)
    // would be a second scan to learn the same bit.
    const { results } = await this.db
      .prepare(LIST_SQL)
      .bind(principal.appId, principal.instanceId, query.afterId, query.engineVersion, query.contentVersion, query.limit + 1)
      .all<RecordRow>();

    const hasMore = results.length > query.limit;
    const page = hasMore ? results.slice(0, query.limit) : results;

    return {
      records: page.map((row) => this.toStoredRecord(principal, row)),
      hasMore,
    };
  }

  /** `app_id` and `instance_id` come from the principal — see {@link LIST_SQL} on the absent join. */
  private toStoredRecord(principal: ReadPrincipal, row: RecordRow): StoredRecord {
    return {
      id: row.id,
      app_id: principal.appId,
      instance_id: principal.instanceId,
      client_id: row.client_id,
      created_date: row.created_date,
      received_date: row.received_date,
      engine_version: row.engine_version,
      content_version: row.content_version,
      // Safe against a throw by `CHECK (json_valid(app_data))` in the schema, and that CHECK exists
      // for this line: pages are ordered by id, so one unparseable row would wedge a reader's
      // download at that cursor forever with no way to step over it.
      app_data: JSON.parse(row.app_data) as unknown,
    };
  }
}
