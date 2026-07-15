/**
 * Applies the D1 schema to the test database.
 *
 * Registered as a `setupFiles` entry, so it runs once per test file, before that file's tests, and
 * outside any test — which is what makes it survive the per-test storage rollback that the pool's
 * `isolatedStorage` performs. Each test file gets its own storage and so re-applies the migrations;
 * that is cheap and correct, since `applyD1Migrations` keeps a `d1_migrations` bookkeeping table
 * and is idempotent.
 *
 * The migrations arrive as a binding rather than being read from disk here: this module executes
 * inside the Workers runtime, which has no filesystem. `vitest.config.mts` reads them Node-side.
 */

import { applyD1Migrations, env } from 'cloudflare:test';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
