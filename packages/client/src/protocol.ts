/**
 * The wire contract, re-declared.
 *
 * The service's public surface — `ErrorCode`, the record and page shapes, the limits — lives in the
 * Worker's private `src/`, which this package cannot import: `packages/client/tsconfig.json` sets
 * `types: []` and `lib: ["DOM"]` on purpose, and `src/storage.ts` reaches `request.cf` through
 * `src/provenance.ts`, which needs the Cloudflare `Request`. So the contract is declared twice and
 * the two copies are pinned against each other by tests. See `protocol.parity.spec.ts` (constants
 * and error codes, comparing against the Worker's source) and `test/client-protocol.spec.ts` (the
 * shapes, comparing against what the handlers actually emit).
 *
 * Two properties of this file are load-bearing:
 *
 * - **It has no imports and names no global.** `test/client-protocol.spec.ts` runs in the Workers
 *   pool and imports this module to compare the key arrays below against live handler output. That
 *   import direction is the only safe one — client -> Worker is poisoned by `types: []` — and it
 *   only stays safe while this file depends on nothing.
 * - **The `*_KEYS` arrays exist at runtime.** A type-level parity assertion is a red *typecheck*,
 *   not a red *test*; `npx vitest run` would stay green while the contract drifted. These ~30 lines
 *   are the price of drift being a failing test. They are deliberately not re-exported from
 *   `index.ts`, so the bundler drops them from what a consumer ships.
 */

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * Maximum records the service accepts in one write batch. Larger batches are rejected whole, so the
 * queue never builds one bigger than this.
 */
export const MAX_RECORDS_PER_BATCH = 100;

/**
 * Maximum size of one record's `app_data`, measured on its compact `JSON.stringify` form rather
 * than on the bytes sent. That is what makes the verdict predictable locally, which is why this
 * client checks it before enqueueing instead of discovering it hours later as a `rejected`.
 */
export const MAX_APP_DATA_BYTES = 64 * 1024;

/** Hard cap on the request body. Batches are built to stay under a fraction of this. */
export const MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024;

/** Bound on `engine_version` / `content_version`. */
export const MAX_VERSION_LENGTH = 256;

/** Page size the service uses when a read omits `limit`. */
export const READ_LIMIT_DEFAULT = 100;

/** Largest page size a read may ask for. */
export const READ_LIMIT_MAX = 1000;

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

/**
 * The service's failure vocabulary. Mirrors `src/error-codes.ts`; the parity spec compares the two
 * arrays element for element.
 */
export const ERROR_CODES = [
  'invalid_json',
  'invalid_request',
  'invalid_field',
  'batch_too_large',
  'unauthorized',
  'forbidden',
  'not_found',
  'method_not_allowed',
  'payload_too_large',
  'unsupported_media_type',
  'internal_error',
  'unavailable',
] as const;

/**
 * Branch on this, never on `message`. The prose is free to be reworded; the code is not.
 *
 * Note that a code does not imply a status — `payload_too_large` arrives both as a 413 on the whole
 * request and inside a per-record result when one `app_data` is over the limit.
 */
export type ErrorCode = (typeof ERROR_CODES)[number];

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * One record as it goes on the wire. snake_case because that is what it is — this type is built by
 * the queue and serialized verbatim, never re-mapped at flush time.
 *
 * `content_version` is optional and, when it does not apply, must be **omitted**. Sending `null` is
 * a validation error at the service: absent and null are different things there, and only absent is
 * spellable.
 */
export interface WireRecord {
  readonly client_id: string;
  readonly created_at: string;
  readonly engine_version: string;
  readonly content_version?: string;
  readonly app_data: unknown;
}

/** The POST body. */
export interface WriteRequest {
  readonly records: readonly WireRecord[];
}

/** The three verdicts, all of them permanent. `duplicate` is an acknowledgement, not an error. */
export const RECORD_STATUSES = ['created', 'duplicate', 'rejected'] as const;

export type RecordStatus = (typeof RECORD_STATUSES)[number];

/**
 * One entry of a write response, **positionally aligned** with the submitted records: same length,
 * same order.
 *
 * It is deliberately not keyed by `client_id`, because a batch may legitimately carry the same one
 * twice — position is the only total mapping. Anything in this client that matches a result to a
 * record does so by index, and then translates that index to the queue's own `seq`.
 *
 * `client_id` is `null` when the submitted one was itself unusable, which is why outcomes are always
 * reported with the id this client minted rather than with the echo.
 */
export interface RecordResult {
  readonly client_id: string | null;
  readonly status: RecordStatus;
  readonly error?: ErrorCode;
  readonly message?: string;
}

export interface WriteResponse {
  readonly results: readonly RecordResult[];
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * A stored record as the read endpoint returns it. Verbatim wire shape, passed through unmodified.
 *
 * **There are no times here, only dates, and that is the design.** `created_date` is the date of the
 * client's `created_at` in the exhibit's local frame; `received_date` is the server's UTC date. The
 * two are in different frames and may differ by one around midnight — a skew smell test, never an
 * exact difference. The exact timestamps live in an operator-only log that no key can read and that
 * is swept after 90 days.
 */
export interface StoredRecord {
  /** Monotonic, and the download cursor. Gaps are normal; never infer a count from it. */
  readonly id: number;
  readonly app_id: string;
  readonly instance_id: string;
  readonly client_id: string;
  /** `YYYY-MM-DD`, exhibit-local. */
  readonly created_date: string;
  /** `YYYY-MM-DD`, UTC. */
  readonly received_date: string;
  readonly engine_version: string;
  readonly content_version: string | null;
  readonly app_data: unknown;
}

/**
 * One page of records.
 *
 * **`records.length < limit` does not mean end-of-stream — only `has_more: false` does.** A page can
 * be short because it hit the service's response byte budget, which is normal rather than an error.
 * `next_after_id` is always a number: the last returned id, or the `after_id` you passed on an empty
 * page, so the walk needs no special case.
 */
export interface RecordPage {
  readonly records: readonly StoredRecord[];
  readonly next_after_id: number;
  readonly has_more: boolean;
}

/** An error body. `internal_error` is the one code that arrives without a `message`. */
export interface ErrorBody {
  readonly error: ErrorCode;
  readonly message?: string;
}

// ---------------------------------------------------------------------------
// Key arrays — the runtime half of the parity check
// ---------------------------------------------------------------------------

/** Every key the service accepts on a record. Anything else is rejected, not ignored. */
export const WIRE_RECORD_KEYS = ['client_id', 'created_at', 'engine_version', 'content_version', 'app_data'] as const;

/** Keys always present on a result. */
export const RECORD_RESULT_REQUIRED_KEYS = ['client_id', 'status'] as const;

/** Keys present only on a `rejected` result. */
export const RECORD_RESULT_OPTIONAL_KEYS = ['error', 'message'] as const;

export const WRITE_RESPONSE_KEYS = ['results'] as const;

export const STORED_RECORD_KEYS = [
  'id',
  'app_id',
  'instance_id',
  'client_id',
  'created_date',
  'received_date',
  'engine_version',
  'content_version',
  'app_data',
] as const;

export const RECORD_PAGE_KEYS = ['records', 'next_after_id', 'has_more'] as const;

/**
 * Every query parameter the read endpoint accepts.
 *
 * No `app` or `instance`, and there will not be: scope comes from the key. Since unknown parameters
 * are rejected rather than ignored, a client sending one gets a 400 naming it — which is the point,
 * because a typo'd `?after=` would otherwise silently reset the cursor to 0 and re-download the
 * whole corpus while reporting success.
 */
export const READ_QUERY_KEYS = ['after_id', 'limit', 'engine_version', 'content_version'] as const;
