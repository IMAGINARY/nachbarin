/**
 * Worker entry point for the exhibit data-capture API.
 *
 * Wiring only. All request handling lives in `app.ts`, which takes its dependencies as an argument
 * so it can be driven in tests without a database.
 *
 * Both seams are backed by D1: keys resolve against `api_keys`, records land in `records`.
 *
 * - `npm run dev` to serve locally, `npm run deploy` to publish
 * - Bindings go in `wrangler.jsonc`; run `npm run cf-typegen` afterwards to refresh `Env`
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import { handleRequest } from './app';
import { D1KeyStore } from './d1-key-store';
import { D1RecordStore } from './d1-record-store';
import type { Deps } from './storage';

function createDeps(env: Env): Deps {
  return {
    keyStore: new D1KeyStore(env.DB),
    recordStore: new D1RecordStore(env.DB),
    now: () => new Date(),
  };
}

export default {
  // No `ctx`: nothing hands work to `waitUntil` yet.
  fetch(request, env): Promise<Response> {
    return handleRequest(request, createDeps(env));
  },
} satisfies ExportedHandler<Env>;
