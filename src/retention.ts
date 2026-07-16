/**
 * The `record_submissions` sweep.
 *
 * Driven by a cron trigger (`wrangler.jsonc`) through the `scheduled` handler in `index.ts`, rather
 * than by a `DELETE` in the README next to minting a key and exporting the corpus.
 *
 * That precedent deliberately does not transfer, and it is worth saying why, because the README is
 * otherwise emphatic that this kind of work is typed by hand. What it argues for is that *rare,
 * irreversible acts should be deliberate* — reviewed at the moment someone types them, because there
 * is no undo. A daily purge is the opposite on every count: routine, expected, and worth nothing at
 * all if it depends on somebody remembering. (0003 makes the same move about AUTOINCREMENT: the
 * argument is real, and it is about a different situation.)
 *
 * The stakes are also asymmetric. `migrations/0003_create_records.sql`, README, `storage.ts` and the
 * OpenAPI spec all rest the date-only design on the exact timestamps living somewhere with "its own
 * retention". A retention nobody runs is not a weaker version of that promise — it makes the
 * schema a permanent, precise-timestamp archive, which is the one outcome the whole design exists to
 * prevent. A promise kept by a human remembering is not a promise.
 */

import { METADATA_RETENTION_DAYS } from './config';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * `received_at` is fixed-width RFC 3339 UTC (`toISOString()`, pinned by a CHECK), so a string
 * comparison is a chronological one — the property 0001 noted when it chose the format. No
 * `strftime`, no date parsing, and the `record_submissions_by_received_at` index serves it directly.
 *
 * Strictly `<`: a row exactly on the boundary is exactly `METADATA_RETENTION_DAYS` old and has not
 * yet outlived the window. The direction is arbitrary by a millisecond and pinned by a test, because
 * the two ways to get it wrong are "kept data a day too long" and "deleted data a day early", and
 * neither should be settled by accident.
 *
 * Unbounded, rather than a `LIMIT`ed loop, and that is measured rather than assumed: 200k rows sweep
 * in ~420ms on the local engine, so even the retry-storm day 0004's header describes (~864k rows) is
 * a couple of seconds. A steady state is a single day's rows. If this ever does start timing out,
 * the failure is silent by nature -- a sweep that stops looks exactly like one that runs -- so it
 * would want a bounded loop and an alarm, not a bigger timeout.
 */
const PURGE_SQL = `DELETE FROM record_submissions WHERE received_at < ?1`;

/**
 * Deletes submission log rows older than {@link METADATA_RETENTION_DAYS}.
 *
 * Touches `record_submissions` and nothing else. `records` is not retention-limited — it is the
 * product, it holds no exact times, and a sweep that reached it would silently destroy the corpus.
 *
 * @param now the cutoff's reference point. Callers pass `controller.scheduledTime`, not the wall
 *   clock: the window is a property of the event, so a delayed or retried run computes the same one.
 * @returns rows deleted, for the caller to log. An unobservable cron is indistinguishable from a
 *   broken one, and this one's failure mode is silence.
 *
 * No try/catch, for the reason both D1 adapters give: a failure must propagate. A swallowed error
 * here is a retention policy that has quietly stopped running.
 */
export async function purgeExpiredSubmissions(db: D1Database, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - METADATA_RETENTION_DAYS * MS_PER_DAY).toISOString();

  const { meta } = await db.prepare(PURGE_SQL).bind(cutoff).run();

  return meta.changes;
}
