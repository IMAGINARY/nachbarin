/**
 * Worker entry point for the exhibit data-capture API.
 *
 * Wiring only. All request handling lives in `app.ts`, which takes its dependencies as an argument
 * so it can be driven in tests without a database; the sweep behind `scheduled` lives in
 * `retention.ts` for the same reason.
 *
 * Both seams are backed by D1: keys resolve against `api_keys`, records land in `records`, and their
 * provenance lands in `record_submissions` in the same transaction.
 *
 * - `npm run dev` to serve locally, `npm run deploy` to publish
 * - Bindings go in `wrangler.jsonc`; run `npm run cf-typegen` afterwards to refresh `Env`
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import { handleRequest } from './app';
import { D1KeyStore } from './d1-key-store';
import { D1RecordStore } from './d1-record-store';
import { consoleLogger, describeError } from './observability';
import { purgeExpiredSubmissions } from './retention';
import type { Deps } from './storage';

function createDeps(env: Env): Deps {
  return {
    keyStore: new D1KeyStore(env.DB, consoleLogger),
    recordStore: new D1RecordStore(env.DB),
    now: () => new Date(),
    newSubmissionId: () => crypto.randomUUID(),
    log: consoleLogger,
  };
}

export default {
  // No `ctx`: nothing hands work to `waitUntil` yet.
  fetch(request, env): Promise<Response> {
    return handleRequest(request, createDeps(env));
  },

  /**
   * Deletes `record_submissions` rows past their retention window. Scheduled in `wrangler.jsonc`.
   *
   * `controller.scheduledTime` rather than `new Date()`: the window is a property of the event, so a
   * run that fires late — or is retried — computes the same cutoff it would have computed on time.
   *
   * No `ctx` here either. This awaits its own work, so there is nothing to hand to `waitUntil`.
   */
  async scheduled(controller, env): Promise<void> {
    // `scheduled_time` and not the wall clock, for the reason above: it is what says whether this run
    // was on time, and the cutoff it computed follows from it.
    const fields = { event: 'retention_sweep', cron: controller.cron, scheduled_time: new Date(controller.scheduledTime).toISOString() };

    // The catch is here and not in `retention.ts`, which documents having none: the sweep must still
    // fail loudly, and it does — this rethrows. What the catch buys is that one filter on
    // `event = "retention_sweep"` returns the runs and the failures together, rather than the
    // failures only being visible as an unexplained `outcome: "exception"` on the invocation log.
    let deleted: number;
    try {
      deleted = await purgeExpiredSubmissions(env.DB, new Date(controller.scheduledTime));
    } catch (error) {
      consoleLogger.error({ ...fields, ...describeError(error) });
      throw error;
    }

    // The only evidence this ran. A sweep that fails is silent by nature — nobody notices data that
    // did not get deleted — so it says so on every run, including the (normal, expected) zero.
    //
    // Not an audit, though: Workers Logs keeps 3–7 days and this window is 90. "Has the sweep been
    // running?" is answered by `SELECT min(received_at) FROM record_submissions`. See
    // `docs/observability.md`.
    consoleLogger.info({ ...fields, deleted });
  },
} satisfies ExportedHandler<Env>;
