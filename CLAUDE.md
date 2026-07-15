# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`nachbarin` is a Cloudflare Worker (TypeScript), scaffolded with the create-cloudflare CLI. The Worker entry point is `src/index.ts`, exporting a default `ExportedHandler<Env>` whose async `fetch(request, env, ctx)` handles requests. It currently returns "Hello World!" — application routing/logic is not built yet.

## Commands

- `npm run dev` (or `npm start`) — local dev server via `wrangler dev` (http://localhost:8787)
- `npm run deploy` — deploy to Cloudflare via `wrangler deploy`
- `npm test` — run the vitest suite in watch mode
- `npx vitest run` — run all tests once (no watch)
- `npx vitest run test/index.spec.ts` — run a single test file; add `-t "<name>"` to filter by test name
- `npm run cf-typegen` — regenerate the `Env` type in `worker-configuration.d.ts` via `wrangler types`

There is no lint step; type-checking is via strict `tsconfig.json`.

## Architecture & conventions

- **Bindings and runtime config** live in `wrangler.jsonc` (KV, R2, D1, Durable Objects, vars, service bindings, etc.); `nodejs_compat` is enabled and `compatibility_date` is pinned there. After changing bindings, run `npm run cf-typegen` so the `Env` interface stays in sync.
- **`worker-configuration.d.ts` is generated** — do not edit by hand. It is registered in tsconfig `types`, so `Env` is globally available in `src/` without an import.
- **Tests** use `@cloudflare/vitest-pool-workers` and run inside the actual Workers runtime (`vitest.config.mts` points at `wrangler.jsonc`). Import helpers from `cloudflare:test` (`env`, `createExecutionContext`, `waitOnExecutionContext`, `SELF`). Two styles exist in `test/index.spec.ts`: unit (call `worker.fetch(...)` directly) and integration (`SELF.fetch(...)`). `test/` has its own `test/tsconfig.json`.

## Cloudflare docs

`AGENTS.md` is the authoritative agent guide for this repo. Its key directive: Workers APIs and limits change frequently — retrieve current docs before Workers/KV/R2/D1/Durable Objects/Queues/Vectorize/AI/Agents work (Cloudflare docs MCP `https://docs.mcp.cloudflare.com/mcp`, or https://developers.cloudflare.com/workers/) rather than relying on prior knowledge.
