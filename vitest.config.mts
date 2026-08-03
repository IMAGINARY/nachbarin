import { defineConfig } from 'vitest/config';

// Orchestrator only. Three projects with different runtimes, one per config file so each keeps its
// own plugins/pool: `test/` runs in the Workers pool (see test/vitest.config.mts), `scripts/` and
// `packages/client/` run in plain Node (see their own configs). `npx vitest run` executes all three.
export default defineConfig({
  test: {
    projects: ['./test/vitest.config.mts', './scripts/vitest.config.mts', './packages/client/vitest.config.mts'],
    // `worker.spec.ts` drives the real `index.ts`, so it reaches the real `consoleLogger` and prints
    // a JSON line per request — by design, and unreadable a dozen at a time. `passed-only` keeps the
    // output of a *failing* test, which is the only time it is worth reading.
    //
    // It belongs here and not in `test/vitest.config.mts`: `silent` is a non-project option, so
    // setting it there is accepted and then ignored.
    silent: 'passed-only',
  },
});
