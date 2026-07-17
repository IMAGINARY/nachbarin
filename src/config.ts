/**
 * Tunable limits for the ingestion API.
 *
 * These are constants rather than environment variables: they are part of the API contract that
 * client authors code against, so changing one is a deliberate, reviewable act rather than a
 * per-deployment knob.
 *
 * {@link METADATA_RETENTION_DAYS} and {@link MAX_SUBMISSIONS_PER_RECORD} are the exceptions to that
 * description, and they are here anyway. Both are invisible to clients — they govern a table clients
 * cannot read, and neither can change a response — so they are policy rather than contract. But "a
 * deliberate, reviewable act" is the *more* true of them, not less, and a second constants file
 * holding two numbers would be the worse answer.
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
 * This number is what buys the date-only design of `records` (see `docs/database.md`). That table
 * gives up exact timestamps on the argument that they survive somewhere narrower and shorter-lived;
 * this is the "shorter-lived". Raising it weakens that argument, and raising it far enough makes the
 * schema a permanent archive of precisely what it was built not to keep.
 *
 * Enforced by the `scheduled` handler in `index.ts`, not by anyone remembering. See `retention.ts`.
 */
export const METADATA_RETENTION_DAYS = 90;

/**
 * How many `record_submissions` rows are kept for one (installation, client_id).
 *
 * The log's grain is one row per submitted record per POST, duplicates included, so a client stuck in
 * a retry loop writes rows in proportion to the loop rather than to the data. This bounds that.
 * Enforced in the log's INSERT in `d1-record-store.ts` and deliberately not by a CHECK — read the
 * comment there before moving it.
 *
 * ## What an uncapped storm costs
 *
 * The binding ceilings are the free plan's: 500 MB per database and — reached first — **100k rows
 * written per day**, with an index write counting as a row written. Each row here costs about three
 * (the table plus its two indexes), so an uncapped storm of 100 records every 10s (~864k rows/day)
 * exhausts the day's quota in roughly three hours. D1 then rejects every query, for *every*
 * installation, until the quota resets at 00:00 UTC.
 *
 * That is the mild failure: it heals itself at midnight. A full database does not. It stops ingestion
 * until the sweep catches up — up to {@link METADATA_RETENTION_DAYS} — or until someone notices and
 * deletes rows by hand, and because these rows share the record insert's transaction it stops
 * ingestion for installations that did nothing wrong. This cap makes the first a non-event and the
 * second unreachable for storm traffic: capped at ten, that same storm stores 1,000 rows a day rather
 * than 864k, and writes 3,000 against the quota rather than exhausting it.
 *
 * ## Why ten, and why flat
 *
 * Ten keeps the first ~100 seconds of a 10s retry loop, which is enough to read the retry *rate* off
 * the `received_at` values rather than merely the fact that a loop happened.
 *
 * Flat rather than per-day because the exhibits reset nightly onto a read-only disk overlay, taking
 * the send queue with them: a client_id cannot be resubmitted across days, so a per-record storm is
 * already bounded to a day and a per-day cap would buy nothing but a wider index. Nor is the storm's
 * duration lost with it — after each reset the exhibit rolls *fresh* client_ids, so a fault that
 * persists appears as a new cohort of capped-out records every day, and duration stays legible at the
 * installation even though it is gone from the record. If the exhibits ever stop resetting nightly,
 * this has to become per-day; `d1-record-store.ts` says what that costs.
 *
 * ## What this does not bound
 *
 * Only *repeated* client_ids. A client inventing a fresh one every time is writing records, and
 * `records` has no sweep at all — it is the product. A busy exhibit is thousands of records a day
 * at up to {@link MAX_APP_DATA_BYTES} each, against the same 500 MB, so on a
 * long-lived installation `records` reaches the ceiling first and this cap does nothing about it. The
 * answer there is the paid plan or an export-and-prune, and it is not a cap.
 */
export const MAX_SUBMISSIONS_PER_RECORD = 10;
