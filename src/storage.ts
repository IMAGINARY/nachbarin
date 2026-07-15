/**
 * Persistence boundary.
 *
 * Nothing here is implemented yet — these are the seams the database adapter will fill. Handlers
 * depend only on the interfaces, so the adapter drops in without touching request-handling logic,
 * and tests substitute in-memory fakes.
 *
 * `KeyStore` and `RecordStore` are separate on purpose. Authentication must happen before the
 * request body is read, so key resolution sits on a different (and much hotter, much more
 * cacheable) path than record persistence. Splitting them also lets tests exercise every
 * validation path against a real fake `KeyStore` while `RecordStore` is still a stub.
 */

import type { InstallationPrincipal, Principal } from './auth';

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
 * never be re-interpreted past validation, and every SQL driver binds `jsonb` from a string
 * anyway. Serializing during validation (where the size limit is measured) rather than at insert
 * time makes the measured size and the stored bytes provably identical.
 */
export interface NewRecord {
  /** Canonical lowercase UUID. Unique within an installation; this is the idempotency key. */
  readonly clientId: string;
  /** The client's RFC 3339 string, verbatim — offset preserved rather than normalized to UTC. */
  readonly createdAt: string;
  readonly engineVersion: string;
  /** Null when the app has no meaningful notion of content version. Never an empty string. */
  readonly contentVersion: string | null;
  /** Compact `JSON.stringify` output. Persist as `jsonb`; a JSON `null` here must become
   *  `'null'::jsonb`, not SQL NULL. */
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

/** A persisted record. snake_case because this is also the read endpoint's wire shape. */
export interface StoredRecord {
  /** Monotonic. This is the incremental-download cursor. */
  readonly id: number;
  readonly app_id: string;
  readonly instance_id: string;
  readonly client_id: string;
  /** Client-reported creation time. */
  readonly created_at: string;
  /** Server clock at ingestion. Stored alongside `created_at` so clock skew stays detectable. */
  readonly received_at: string;
  readonly engine_version: string;
  readonly content_version: string | null;
  readonly app_data: unknown;
}

export interface ListQuery {
  /** Exclusive lower bound on `id`. Zero means "from the beginning". */
  readonly afterId: number;
  readonly limit: number;
  readonly appId: string | null;
  readonly instanceId: string | null;
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
   * @param receivedAt a single server timestamp for the whole batch.
   * @returns outcomes positionally aligned with `records` — same length, same order.
   *
   * Must **throw** on transient failure rather than reporting a per-record outcome. Clients treat
   * `created` and `duplicate` as acknowledgment and drop those records from their retry queue, so
   * reporting a transient failure as an outcome would silently discard data. Throwing surfaces as
   * 500/503 and the client retries the whole batch, which `client_id` makes safe.
   */
  insert(
    principal: InstallationPrincipal,
    receivedAt: Date,
    records: readonly NewRecord[],
  ): Promise<InsertOutcome[]>;

  list(query: ListQuery): Promise<ListPage>;
}

/** Thrown by the stubs below. Maps to 501. */
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

export const notImplementedKeyStore: KeyStore = {
  resolve() {
    return Promise.reject(new NotImplementedError('KeyStore.resolve'));
  },
};

export const notImplementedRecordStore: RecordStore = {
  insert() {
    return Promise.reject(new NotImplementedError('RecordStore.insert'));
  },
  list() {
    return Promise.reject(new NotImplementedError('RecordStore.list'));
  },
};

/** Everything a request handler needs from the outside world. */
export interface Deps {
  readonly keyStore: KeyStore;
  readonly recordStore: RecordStore;
  /** Injected so `received_at` is assertable in tests. */
  readonly now: () => Date;
}
