# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`nachbarin` is a Cloudflare Worker (TypeScript) exposing a data-capture API for museum exhibits: exhibition software ("apps") POSTs records of visitor interactions, and an operator bulk-downloads them incrementally. Two endpoints, both under `/v1/records` — POST to write, GET to read. See `README.md` for the product context.

**Vocabulary.** An **app** is the software module (`future-mobility-simulator`); an **instance** is where it runs (a museum, or one copy of a travelling exhibition); an **installation** is the `(app, instance)` pair. A record belongs to an installation, and a write key grants exactly one. Use these three words precisely — "exhibit" means the physical thing in the museum (furniture, hardware, texts) and is never an identifier.

**Records are not stored yet.** `src/storage.ts` defines the `KeyStore`/`RecordStore` seams. `KeyStore` is implemented against D1 (`src/d1-key-store.ts`), so authentication is real; `RecordStore` is still `notImplementedRecordStore`, so a request that gets past auth and validation and actually needs records answers 501. Everything else on the request path is complete.

## Commands

- `npm run dev` (or `npm start`) — local dev server via `wrangler dev` (http://localhost:8787)
- `npm run deploy` — deploy to Cloudflare via `wrangler deploy`
- `npm test` — run the vitest suite in watch mode
- `npx vitest run` — run all tests once (no watch)
- `npx vitest run test/validation.spec.ts` — run a single test file; add `-t "<name>"` to filter by test name
- `npm run lint` — eslint (type-aware, covers `src/` and `test/`)
- `npx tsc --noEmit` — type-check `src/`; `npx tsc --noEmit -p test/tsconfig.json` for `test/` (the root config excludes it)
- `npm run cf-typegen` — regenerate the `Env` type in `worker-configuration.d.ts` via `wrangler types`
- `npm run db:migrate:local` — apply `migrations/` to the local D1. There is deliberately **no** `db:migrate:remote` script: that command rewrites production, D1 has no down-migrations, and it should be typed on purpose (`npx wrangler d1 migrations apply nachbarin --remote`). See README "Operations" for minting and revoking keys.

## Architecture & conventions

- **`src/index.ts` is wiring only** (build `Deps`, delegate). Request handling lives in `src/app.ts`, whose `handleRequest(request, deps)` takes its dependencies as an argument — that injection point is what makes the API testable without a database, so keep logic out of `index.ts`.
- **Module layout**: `app.ts` (routing + error boundary) → `handlers.ts` (the two endpoints) → `validation.ts` (pure, synchronous) / `storage.ts` (the persistence seam). `d1-key-store.ts` is the D1 adapter behind that seam. `http.ts` holds response builders and the capped body reader; `config.ts` holds the limit constants; `auth.ts` holds the `Principal` union.
- **Zero runtime dependencies** — no router, no validation library. Keep it that way unless there's a strong reason.
- **Bindings and runtime config** live in `wrangler.jsonc`; `nodejs_compat` is enabled and `compatibility_date` is pinned there. After changing bindings, run `npm run cf-typegen` so `Env` stays in sync. The one binding is `DB` (D1); `createDeps(env)` reads it.
- **The schema** lives in `migrations/`, applied via `wrangler d1 migrations apply`. Two tables: `installations` (the `(app_id, instance_id)` pair, surrogate `id`) and `api_keys` (sha256 hashes, soft-deleted via `revoked_at`). Read the comments in `migrations/0001_*.sql` before changing either — several constraints are load-bearing and the reasoning is recorded there. **SQLite does not enforce `VARCHAR(n)` lengths**, so every length limit is a `CHECK`.
- **`worker-configuration.d.ts` is generated** — do not edit by hand. It is registered in tsconfig `types`, so `Env` is globally available in `src/` without an import.
- **Tests** use `@cloudflare/vitest-pool-workers` and run inside the actual Workers runtime (`vitest.config.mts` points at `wrangler.jsonc`). Most specs drive `handleRequest` with the in-memory fakes from `test/fakes.ts` (real dedupe and cursor semantics); `test/worker.spec.ts` and `test/d1-key-store.spec.ts` run against a real local D1. `test/` has its own `test/tsconfig.json` and is excluded from the root one.
- **Migrations in tests**: `vitest.config.mts` reads `migrations/` Node-side (the Workers runtime has no filesystem) and passes them as the `TEST_MIGRATIONS` binding; `test/apply-migrations.ts` applies them per test file via `setupFiles`. `TEST_MIGRATIONS` is declared by hand in `test/env.d.ts` because it is not a real binding and `wrangler types` will never emit it.
- **`FakeKeyStore` stores keys verbatim and should stay that way.** Hashing is an implementation detail of the D1 adapter, not part of the `KeyStore` contract, and no handler test can observe it. The gap that leaves is closed by `test/d1-key-store.spec.ts`, whose golden hashes are **hardcoded, not computed** — deriving them from the code under test would make the assertion a tautology.
- **Style**: 2-space indent, single quotes, semicolons, 140 cols (`.prettierrc`). Note `.idea/codeStyles/Project.xml` still says tabs; Prettier wins on save.

## Invariants worth knowing before you change behaviour

These are load-bearing and each has a regression test. Read the comment at the definition before touching them.

- **Never use `Date.parse` on `created_at`.** It does not reject out-of-range days, it silently rolls them over (`2026-02-30` → March 2nd). `validation.ts` range-checks every component, days-in-month included.
- **`rejected` means "never retry".** Clients drop anything acknowledged as `created`/`duplicate`/`rejected` from their queue, so a *transient* storage failure must throw (→ 500/503) and never be reported as a per-record outcome. `InsertOutcome` has no `rejected` variant for this reason.
- **A write's `results` is positionally aligned with the submitted `records`** — same length, same order. It is not keyed by `client_id`, because a batch may legitimately contain the same one twice.
- **Dedupe is scoped to the installation — the `(app_id, instance_id)` pair — never to `instance_id` alone.** `instance_id` is not globally unique; it defaults to `default`, so two apps at one instance would collide and the second's records would come back `duplicate`, which this protocol defines as success. The client would drop them from its queue and they would be lost silently. The schema gives the pair a surrogate key so `(installation, client_id)` is unambiguous.
- **`app_data` is opaque and never interpreted.** Any JSON value is valid; only presence is required.
- Identity comes from the API key alone, never the request body.
- **`KeyStore.resolve` must never turn a database failure into `null`.** `null` means 401, which tells a client its credential is bad — the one conclusion it must not draw from an outage, since a well-behaved client may then stop retrying and discard queued records. Let D1 errors propagate to the 500 boundary in `app.ts`.
- **`api_keys.kind` is redundant with `installation_pk IS NULL`, and stays anyway.** Without it, an operator hand-writing an `INSERT` who omits `installation_pk` does not get an error — they get a working *read* key that can download every app's records. A typo must not be a privilege escalation. The biconditional `CHECK` keeps the two columns honest.
- **The key hash must match `printf %s "$key" | shasum -a 256`** — UTF-8, no trailing newline, lowercase hex. `echo` appends a newline and yields a key that 401s forever, indistinguishably from a revoked one. Pinned by the golden fixtures in `test/seed.ts`.

## Cloudflare docs

`AGENTS.md` is the authoritative agent guide for this repo. Its key directive: Workers APIs and limits change frequently — retrieve current docs before Workers/KV/R2/D1/Durable Objects/Queues/Vectorize/AI/Agents work (Cloudflare docs MCP `https://docs.mcp.cloudflare.com/mcp`, or https://developers.cloudflare.com/workers/) rather than relying on prior knowledge.
