# CLAUDE.md

Guidance for Claude Code in this repository. This file is a map and a list of rules; the reasoning lives beside the code. Every rule below has a comment at its definition and a regression test — read the comment before changing the behaviour.

## Project

`nachbarin` is a Cloudflare Worker (TypeScript, D1) that captures data from museum exhibits: apps POST records of visitor interactions to `/v1/records`, and a key holder GETs them back in pages. `packages/client/` is the client library apps use to do that; `scripts/` is the operator CLI.

**Vocabulary.** An **app** is the software module (`future-mobility-simulator`); an **instance** is where it runs (a museum, or one copy of a travelling exhibition); an **installation** is the `(app, instance)` pair. A record belongs to an installation, and every API key grants exactly one. "Exhibit" means the physical thing in the museum and is never an identifier.

## The world it runs in

Most of the rules further down follow from these.

- **Exhibits lose their state nightly.** The machines run behind a read-only disk overlay and power off at closing, so a record that has not been sent by then is gone, and nothing upstream can re-send it. We cannot reach into a museum's network, but an exhibit can make outbound HTTPS calls — so the exhibit pushes and this service catches.
- **Writers are unattended kiosks; readers are people we know.** A write key sits in a kiosk browser anyone can inspect, with nobody there to read an error. A read key sits with us or a trusted partner.
- **`read` and `write` keys are not a privilege ladder.** A write key that could read would make every kiosk a download point for its venue's data; a read key that could write would let a buggy script mutate a corpus that has no undo. Every key is scoped to one installation and there is no global read key. Widening any of this is a product decision.
- **The service is general.** The first app is a game; the next ones are surveys and telemetry. `app_data` is opaque and nothing in the schema knows what it contains — do not teach the service about one app's payload.
- **Traffic is very low** (about a dozen records an hour per station) and stays negligible as venues are added. There is no rate limiter, queue or cache, and none is wanted; the limits in `src/config.ts` bound one request's memory, not load.
- **It must keep fitting the Cloudflare free plan.** The limit a fault hits first is D1's 100k rows written per day (index writes count), ahead of the 500 MB database size; Worker CPU is 10 ms per request. Re-check current limits in Cloudflare's docs rather than trusting these numbers. A change that only fits a paid plan needs a conversation before code.
- **GDPR is a design input, and the principle is need-to-know.** `records` keeps dates and never times. Exact timestamps and edge data (IP, user agent) go to `record_submissions`, which has no endpoint, which no key can read, and which a cron sweeps at 90 days. Worker logs carry no visitor data.

## Commands

- `npm run dev` — local server via `wrangler dev` (http://localhost:8787); `npm run deploy` deploys
- `npx vitest run` — all tests once (`npm test` is watch mode); `npx vitest run test/validation.spec.ts -t "<name>"` for one
- `npm run test:e2e` — operator CLI end to end against a throwaway local D1. Slow, and not part of `npm test`
- `npm run lint` — eslint. Formatting is separate: `npm run format` / `npm run format:check`
- Type-checking is four programs: `npx tsc --noEmit` (`src/`), `npx tsc --noEmit -p test/tsconfig.json`, `npm run typecheck:scripts`, `npm run typecheck:client`
- `npm run build:client` — build the client with tsdown (`npm run dev:client` to watch). **The build does not type-check**, so `typecheck:client` is not optional
- `npm run cf-typegen` — regenerate `worker-configuration.d.ts` after changing bindings in `wrangler.jsonc`. Never edit that file by hand
- `npm run admin -- <command> <subcommand>` — the operator CLI. `--local` by default; `--remote` must be typed
- `npm run db:migrate:local` — apply migrations locally. There is deliberately no remote script: type `npx wrangler d1 migrations apply nachbarin --remote` on purpose

## Where things are

| For                                                  | Read                                                                                                 |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Product context, operating the service               | `README.md`, `docs/operations.md`                                                                    |
| The schema and its reasoning, SQLite/D1 traps        | `docs/database.md` — before touching `migrations/` or a D1 adapter                                   |
| What the Worker logs and must never log              | `docs/observability.md` — before adding a log field                                                  |
| The wire contract                                    | `spec/openapi.yaml`, and the doc comments in `src/handlers.ts`                                       |
| Limits and the arithmetic behind them                | `src/config.ts`                                                                                      |
| Client library behaviour                             | `packages/client/README.md`, and the file headers in `packages/client/src/`                          |
| Client build and lint settings, each with its reason | comments in `packages/client/tsdown.config.ts`, `packages/client/tsconfig.json`, `eslint.config.mjs` |

**Worker (`src/`).** `index.ts` is wiring only (build `Deps`, delegate, `scheduled` → retention sweep). `app.ts` (routing, error boundary, the one log line) → `handlers.ts` (the two endpoints) → `validation.ts` (pure, synchronous) and `storage.ts` (the `KeyStore`/`RecordStore` seam, implemented by `d1-key-store.ts` and `d1-record-store.ts`). `handleRequest(request, deps)` takes its dependencies as an argument, which is what makes the API testable without a database — keep logic out of `index.ts`.

**Client (`packages/client/`).** The repo is an npm workspace and this is the only publishable package; the root stays `private` at `0.0.0`. The client re-declares the wire contract in `src/protocol.ts` rather than importing it, and two specs pin the copies together: `packages/client/src/protocol.parity.spec.ts` and `test/client-protocol.spec.ts`. That only works while `src/config.ts`, `src/error-codes.ts` and the client's `protocol.ts` have no imports and name no ambient globals.

**Tests.** Three vitest projects behind the root `vitest.config.mts`: `workers` (`test/`, inside the Workers runtime), `scripts` and `client` (plain Node). Most Worker specs drive `handleRequest` with the fakes in `test/fakes.ts`; `worker.spec.ts`, `d1-key-store.spec.ts` and `d1-record-store.spec.ts` use a real local D1. The pool rolls storage back after every test, so seed inside the test. `FakeKeyStore` stores keys verbatim on purpose — hashing belongs to the D1 adapter, not the `KeyStore` contract — and the golden hashes in `test/seed.ts` that cover it are hardcoded, never computed from the code under test.

## Rules

**Whole repo**

- **Zero runtime dependencies**, in the Worker and in the client — a kiosk bundle is no place for a dependency tree. No router, no validation library.
- **Applied migration SQL is never edited.** Add a new migration and update `docs/database.md`, which states the migration it is based on.
- Style is Prettier's (`.prettierrc`): 2 spaces, single quotes, semicolons, 140 columns.

**Service**

- **`records` stores dates, never times,** and `GET` never returns a time. Do not add a timestamp column.
- **Identity and scope come from the API key alone** — never the body, never the query string. `GET /v1/records` takes no app or instance parameter.
- **`app_data` is opaque.** Any JSON value is valid, only presence is required, and it is stored as JSON text in a `NOT NULL` column.
- **Dedupe is the `UNIQUE (installation_pk, client_id)` constraint** with `ON CONFLICT DO NOTHING` — never a preceding SELECT, and never scoped to `instance_id` alone.
- **`rejected` means "never retry".** Clients drop anything acknowledged as `created`, `duplicate` or `rejected`, so a transient storage failure must throw (→ 500/503) and never become a per-record outcome.
- **`KeyStore.resolve` never turns a database failure into `null`.** `null` means 401, which tells a client its key is bad. The D1 adapters have no try/catch for this reason.
- **A write's `results` is positionally aligned with the submitted `records`.** It is not keyed by `client_id`, because a batch may carry the same one twice.
- **Never use `Date.parse` on `created_at`** — it rolls `2026-02-30` over to March instead of rejecting it.
- **`record_submissions` rows are written in the record insert's transaction.** So the log is a parameter on `RecordStore.insert`, not a third storage seam, and a CHECK that fires there rolls back the whole batch and the client retries into the same 500 forever. Every CHECK on that table must be implied by what the code already produces. The per-record cap (`MAX_SUBMISSIONS_PER_RECORD`) is a `WHERE` in the INSERT for the same reason. The table has one row per submission, duplicates included, and deliberately no FK to `records`.
- **The retention cron must keep running, and must never touch `records`.** The date-only design depends on the timestamps expiring.
- **`records.id` is `AUTOINCREMENT`** because it is the public download cursor and the table gets deletions.
- **D1 limits that fail late:** 100 bound parameters per statement, so inserts are one statement per record inside a `batch()`, never multi-row `VALUES`. A GLOB pattern is capped at 50 bytes and an over-long one fails at INSERT, not when the migration is applied.
- **Logging goes through `src/observability.ts` only**, each call passing exactly one object, one line per request, with failures through `fail()`. Error text from parsing visitor data can quote that data — `handlers.ts` drops its body-parse error on purpose.
- **A key's hash must match `printf %s "$key" | shasum -a 256`** — no trailing newline, lowercase hex. Mint through the CLI.

**Client library**

- **A queued record is never dropped on a 4xx** — 401, 403, 400, 404 and 415 all mean keep retrying. The only drops are a per-record `rejected` and a 413 on a batch of one. `transport.ts` holds the table.
- **A 2xx is success only if the body proves it:** JSON, an object, with a `results` array as long as the batch sent. A captive portal answers `200 text/html`.
- **`WriteClient.flush()` never rejects.** The timer path `void`s it, and an unhandled rejection terminates a Node process.
- **Removal from the send queue is by the queue-local `seq`,** never by `client_id`, and targets the live array.
- **`newUuid()` never throws; `contentVersionOf` throws rather than falling back.** The opposite answers are deliberate: an id only has to be unique, while a hash has to be the same string everywhere.
- **Platform globals are typed from `lib: ["DOM"]` with `types: []`,** and `eslint.config.mjs` bans the browser-only ones. Those two settings are one decision. The client reaches `localStorage` and `crypto` only through `globalThis` casts, in `storage.ts`, `mint.ts` and `content-version.ts`.
- **The queue runs on a main-thread `setTimeout`.** A Web Worker cannot work (no `localStorage` in worker scope, no `import.meta` in the CJS output), and `sendBeacon` and `keepalive` are out too.

## Cloudflare docs

Workers APIs and limits change often. Follow `AGENTS.md`: retrieve current documentation before Workers or D1 work (Cloudflare docs MCP, or https://developers.cloudflare.com/workers/) rather than relying on prior knowledge.
