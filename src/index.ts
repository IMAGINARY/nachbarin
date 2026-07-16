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
import { purgeExpiredSubmissions } from './retention';
import type { Deps } from './storage';

function createDeps(env: Env): Deps {
  return {
    keyStore: new D1KeyStore(env.DB),
    recordStore: new D1RecordStore(env.DB),
    now: () => new Date(),
    newSubmissionId: () => crypto.randomUUID(),
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
    const deleted = await purgeExpiredSubmissions(env.DB, new Date(controller.scheduledTime));

    // The only evidence this ran. A sweep that fails is silent by nature — nobody notices data that
    // did not get deleted — so it says so on every run, including the (normal, expected) zero.
    console.log('purged expired record_submissions', { deleted, cron: controller.cron });
  },
} satisfies ExportedHandler<Env>;
