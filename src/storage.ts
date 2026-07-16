/**
 * Persistence boundary.
 *
 * These are the seams the database adapters fill. Handlers depend only on the interfaces, so an
 * adapter drops in without touching request-handling logic, and tests substitute in-memory fakes.
 *
 * Both are implemented against D1 — see `d1-key-store.ts` and `d1-record-store.ts`.
 *
 * `KeyStore` and `RecordStore` are separate on purpose. Authentication must happen before the
 * request body is read, so key resolution sits on a different (and much hotter, much more
 * cacheable) path than record persistence. Splitting them also lets tests exercise every
 * validation path against a fake `KeyStore` without standing up a database.
 */

import type { Principal, ReadPrincipal, WritePrincipal } from './auth';

export interface KeyStore {
  /**
   * Resolves a presented bearer key to its principal.
   *
   * Implementations should look up by `sha256(key)` rather than storing keys verbatim, so that a
   * database dump leaks no usable credentials. These are high-entropy random tokens, so a plain
   * hash is appropriate; password KDFs solve a problem (low-entropy brute-forcing) that does not
   * apply here and would only add latency.
   *
   * @returns the principal, or null if the key is unknown *or* revoked. The two cases must be
   *   indistinguishable to the caller — both are 401.
   */
  resolve(presentedKey: string): Promise<Principal | null>;
}

/**
 * A record that has passed validation and is ready to persist.
 *
 * `app_data` is carried as serialized JSON text rather than a parsed value: it is opaque and must
 * never be re-interpreted past validation, and the column it lands in is text anyway. Serializing
 * during validation (where the size limit is measured) rather than at insert time makes the measured
 * size and the stored bytes provably identical.
 */
export interface NewRecord {
  /** Canonical lowercase UUID. Unique within an installation; this is the idempotency key. */
  readonly clientId: string;
  /**
   * The client's RFC 3339 string, verbatim — offset preserved rather than normalized to UTC.
   *
   * The records table coarsens this to a date (see `localDateOf`) and keeps no exact time. It is
   * carried at full precision because the metadata table, which lands next, stores it as sent.
   */
  readonly createdAt: string;
  readonly engineVersion: string;
  /** Null when the app has no meaningful notion of content version. Never an empty string. */
  readonly contentVersion: string | null;
  /**
   * Compact `JSON.stringify` output.
   *
   * A JSON `null` is a legal `app_data` and must round-trip as JSON null, never as SQL NULL — the
   * latter says "no payload", which this protocol cannot express. D1 is SQLite and has no `jsonb`;
   * the column is `TEXT NOT NULL`, which is what makes the wrong one unspellable.
   */
  readonly appDataJson: string;
}

/**
 * The outcome of persisting one record.
 *
 * Deliberately has no "rejected" variant. Rejection is a validation verdict that never reaches
 * storage, and a transient failure must not be reported per-record either — see
 * {@link RecordStore.insert}.
 */
export type InsertOutcome = 'created' | 'duplicate';

/**
 * A persisted record. snake_case because this is also the read endpoint's wire shape.
 *
 * Note what is not here: the exact times the client reported and the server observed. Records are
 * stored to a *date* and no finer. `app_data` is coarse enough to be uninteresting on its own, but a
 * precise timestamp is not — against any other timed source it identifies who made which choice, and
 * a date is all anyone downloading this data segments by anyway. The full timestamps live in the
 * metadata table, behind different privileges and a retention policy. See `migrations/0003_*.sql`.
 */
export interface StoredRecord {
  /** Monotonic. This is the incremental-download cursor. */
  readonly id: number;
  readonly app_id: string;
  readonly instance_id: string;
  readonly client_id: string;
  /**
   * `YYYY-MM-DD`, in the exhibit's local frame — the date of the client's `created_at`, offset and
   * all. Trustworthy only as far as the exhibit's clock is; compare against `received_date`.
   */
  readonly created_date: string;
  /**
   * `YYYY-MM-DD`, UTC: the date this Worker took the batch. Server-derived, so it cannot be wrong,
   * but it is not an analytic field — a client may queue for days, so it is when we heard rather
   * than when it happened. It is here so a broken exhibit clock stays detectable after the metadata
   * table's retention window closes. The two dates are in different frames and may legitimately
   * differ by one around midnight: a smell test, never an exact difference.
   */
  readonly received_date: string;
  readonly engine_version: string;
  readonly content_version: string | null;
  readonly app_data: unknown;
}

/**
 * The parts of a read the caller chooses — paging and optional filters.
 *
 * Deliberately carries no app or instance. Which installation's records a download may see is
 * settled by the key, and arrives at {@link RecordStore.list} as a {@link ReadPrincipal}. Keeping
 * the two apart is what lets `validation.ts` stay a pure function of the wire.
 */
export interface ListQuery {
  /** Exclusive lower bound on `id`. Zero means "from the beginning". */
  readonly afterId: number;
  readonly limit: number;
  readonly engineVersion: string | null;
  readonly contentVersion: string | null;
}

export interface ListPage {
  /** Ordered by `id` ascending. */
  readonly records: readonly StoredRecord[];
  /** Whether records exist beyond the last one returned. Implementations should fetch
   *  `limit + 1` rows and report the overflow rather than issuing a second count query. */
  readonly hasMore: boolean;
}

export interface RecordStore {
  /**
   * Persists a batch, deduplicating on `(installation, client_id)`.
   *
   * The scope is the **installation** — the `(app_id, instance_id)` pair — and never `instance_id`
   * alone. `instance_id` is not globally unique: it defaults to `default`, so two different apps at
   * the same instance would collide, and the second one's records would come back `duplicate` and
   * be dropped from its queue as acknowledged. The storage schema expresses the pair as a single
   * surrogate key, which makes `(installation, client_id)` unambiguous.
   *
   * @param receivedAt a single server timestamp for the whole batch. The records table coarsens it
   *   to `received_date` and keeps no exact time; it is passed at full precision because the
   *   metadata table will store it as observed.
   * @returns outcomes positionally aligned with `records` — same length, same order.
   *
   * Must **throw** on transient failure rather than reporting a per-record outcome. Clients treat
   * `created` and `duplicate` as acknowledgment and drop those records from their retry queue, so
   * reporting a transient failure as an outcome would silently discard data. Throwing surfaces as
   * 500/503 and the client retries the whole batch, which `client_id` makes safe.
   */
  insert(principal: WritePrincipal, receivedAt: Date, records: readonly NewRecord[]): Promise<InsertOutcome[]>;

  /**
   * Returns one page of `principal`'s installation's records, oldest first.
   *
   * The principal is the scope and is not optional: implementations must constrain to its
   * `(app_id, instance_id)` pair, not merely filter by it. `query` only narrows further within
   * that scope. A `list` that ignored the principal would hand one museum another's data while
   * every paging test still passed, so it is passed separately from {@link ListQuery} rather than
   * folded into it — the same shape `insert` already uses, and for the same reason.
   */
  list(principal: ReadPrincipal, query: ListQuery): Promise<ListPage>;
}

/**
 * An operation whose seam exists but whose adapter does not. Maps to 501.
 *
 * Nothing throws it today: both stores are implemented. It is kept, with its boundary mapping in
 * `app.ts` and its documented response in the spec, because the metadata store is the next seam to
 * land and will pass through exactly this state.
 */
export class NotImplementedError extends Error {
  constructor(operation: string) {
    super(`${operation} is not implemented yet`);
    this.name = 'NotImplementedError';
  }
}

/**
 * A transient storage failure. Maps to 503 + Retry-After, telling the client to retry the batch.
 * Defined here now so handlers and their tests pin the behaviour before an adapter exists.
 */
export class StorageUnavailableError extends Error {
  constructor(message = 'storage is temporarily unavailable') {
    super(message);
    this.name = 'StorageUnavailableError';
  }
}

/** Everything a request handler needs from the outside world. */
export interface Deps {
  readonly keyStore: KeyStore;
  readonly recordStore: RecordStore;
  /** Injected so `received_date` is assertable in tests. */
  readonly now: () => Date;
}
