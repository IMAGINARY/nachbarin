/**
 * Tunable limits for the ingestion API.
 *
 * These are constants rather than environment variables: they are part of the API contract that
 * client authors code against, so changing one is a deliberate, reviewable act rather than a
 * per-deployment knob.
 *
 * {@link METADATA_RETENTION_DAYS} is the one exception to that description, and it is here anyway.
 * It is invisible to clients — it governs a table they cannot read — so it is a privacy policy
 * rather than a contract. But "a deliberate, reviewable act" is the *more* true of it, not less, and
 * a second constants file holding one number would be the worse answer.
 */

/** Maximum records accepted in a single write batch. Larger batches are rejected whole (400). */
export const MAX_RECORDS_PER_BATCH = 100;

/**
 * Maximum size of a single record's `app_data`, measured on its compact canonical JSON
 * serialization rather than the received bytes. That makes the limit independent of how the
 * client formats its JSON, and lets a client predict the verdict exactly by stringifying locally.
 */
export const MAX_APP_DATA_BYTES = 64 * 1024;

/**
 * Hard cap on the request body. A full batch is 100 x 64KB = 6.4MB, so this leaves envelope
 * headroom while keeping us well clear of the 128MB per-isolate memory budget, which is shared
 * across concurrently executing requests.
 */
export const MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024;

/** Bound on `engine_version` / `content_version`. They are unbounded `text` in the schema. */
export const MAX_VERSION_LENGTH = 256;

/** Page size used when a read request omits `limit`. */
export const READ_LIMIT_DEFAULT = 100;

/** Largest page size a read request may ask for. */
export const READ_LIMIT_MAX = 1000;

/**
 * Byte budget for a read response. A full 1000 x 64KB page would be 64MB against a 128MB
 * per-isolate budget, so pages are truncated to fit. This is safe because `has_more` and
 * `next_after_id` make a short page indistinguishable from any other page to a correct client.
 */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * How long a `record_submissions` row lives, measured from `received_at`.
 *
 * This number is what buys the date-only design in `migrations/0003_create_records.sql`. That table
 * gives up exact timestamps on the argument that they survive somewhere narrower and shorter-lived;
 * this is the "shorter-lived". Raising it weakens that argument, and raising it far enough makes the
 * schema a permanent archive of precisely what it was built not to keep.
 *
 * Enforced by the `scheduled` handler in `index.ts`, not by anyone remembering. See `retention.ts`.
 */
export const METADATA_RETENTION_DAYS = 90;
