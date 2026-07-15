/**
 * Worker entry point for the exhibit data-capture API.
 *
 * Wiring only. All request handling lives in `app.ts`, which takes its dependencies as an argument
 * so it can be driven in tests without a database.
 *
 * Storage is not implemented yet: both stores throw, which surfaces as 501 once a request gets
 * past routing, authentication, and validation.
 *
 * - `npm run dev` to serve locally, `npm run deploy` to publish
 * - Bindings go in `wrangler.jsonc`; run `npm run cf-typegen` afterwards to refresh `Env`
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import { handleRequest } from './app';
import { type Deps, notImplementedKeyStore, notImplementedRecordStore } from './storage';

/** Takes no `Env` yet because there are no bindings; it gains one when storage is wired up. */
function createDeps(): Deps {
  return {
    keyStore: notImplementedKeyStore,
    recordStore: notImplementedRecordStore,
    now: () => new Date(),
  };
}

export default {
  fetch(request): Promise<Response> {
    return handleRequest(request, createDeps());
  },
} satisfies ExportedHandler<Env>;
