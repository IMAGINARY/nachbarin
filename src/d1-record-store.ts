/**
 * D1 adapter for {@link RecordStore}.
 *
 * The other half of the persistence boundary, alongside `d1-key-store.ts`, and the last seam in
 * `storage.ts` to be filled.
 *
 * This adapter is where records get coarsened. It receives a full RFC 3339 `createdAt` and a full
 * `receivedAt`, and deliberately stores only their dates — see `migrations/0003_create_records.sql`
 * for why, and the metadata table (a later change) for where the exact times go instead.
 */

import type { ReadPrincipal, WritePrincipal } from './auth';
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
 * somehow found nothing the NOT NULL fails loudly rather than inventing a row — it cannot, since the
 * key resolved against that very installation moments ago.
 */
const INSERT_SQL = `
  INSERT INTO records (installation_pk, client_id, created_date, received_date, engine_version, content_version, app_data)
  VALUES ((SELECT id FROM installations WHERE app_id = ?1 AND instance_id = ?2), ?3, ?4, ?5, ?6, ?7, ?8)
  ON CONFLICT (installation_pk, client_id) DO NOTHING
`;

/**
 * One page, oldest first, constrained to the caller's installation.
 *
 * The installation is the first thing in the WHERE clause and comes from the principal, never from
 * `query`: a read key sees its own installation and there is no parameter that could widen that.
 *
 * No join back to `installations`, even though `app_id` and `instance_id` are on the wire. Every row
 * this returns belongs to the principal's installation by construction, so the strings are already
 * in hand — 0001 anticipated "a join on every read" as the cost of the surrogate key, and scoping by
 * the principal is what avoids paying it.
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

  async insert(principal: WritePrincipal, receivedAt: Date, records: readonly NewRecord[]): Promise<InsertOutcome[]> {
    // One date for the whole batch, in UTC because it is the server's clock. `created_date` is local
    // instead; the two are not comparable to the day, only to the order of magnitude. See
    // `StoredRecord.received_date`.
    const receivedDate = receivedAt.toISOString().slice(0, 10);
    const statement = this.db.prepare(INSERT_SQL);

    // One statement per record, not a single multi-row VALUES: at 8 parameters each, a full batch of
    // 100 would bind 800, and D1 caps a query at 100 bound parameters. `batch` sends them in one
    // round trip regardless, so the multi-row form would buy nothing it does not already have.
    //
    // Not wrapped in a try/catch, for the reason `d1-key-store.ts` sets out at length: a failure here
    // must reach the error boundary in `app.ts` as a 500. `InsertOutcome` has no failure variant
    // precisely so that this is the only way out. Reporting a transient fault as a per-record outcome
    // would have the client treat it as acknowledged and drop the record from its retry queue.
    //
    // `batch` is also a transaction, so a fault rolls the whole batch back and the client retries it
    // whole — which `client_id` makes safe.
    const results = await this.db.batch(
      records.map((record) =>
        statement.bind(
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
    );

    // `batch` returns one result per statement in order, which is exactly the positional alignment
    // the contract promises the caller — `handlers.ts` indexes this array against the submitted
    // records and would silently mismatch if it were filtered or reordered.
    //
    // `changes` is the whole verdict: `ON CONFLICT DO NOTHING` inserts nothing on a conflict, so 0
    // means the (installation, client_id) was already there. This also gives the right answer for a
    // batch that legitimately carries one client_id twice — statements run sequentially inside the
    // transaction, so the second sees the first and reports `duplicate`.
    return results.map((result) => (result.meta.changes === 1 ? 'created' : 'duplicate'));
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
