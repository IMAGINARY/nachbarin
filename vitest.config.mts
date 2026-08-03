import { defineConfig } from 'vitest/config';

// Orchestrator only. Two projects with different runtimes, one per config file so each keeps its own
// plugins/pool: `test/` runs in the Workers pool (see test/vitest.config.mts), `scripts/` runs in plain
// Node (see scripts/vitest.config.mts). `npx vitest run` executes both.
export default defineConfig({
  test: {
    projects: ['./test/vitest.config.mts', './scripts/vitest.config.mts'],
    // `worker.spec.ts` drives the real `index.ts`, so it reaches the real `consoleLogger` and prints
    // a JSON line per request — by design, and unreadable a dozen at a time. `passed-only` keeps the
    // output of a *failing* test, which is the only time it is worth reading.
    //
    // It belongs here and not in `test/vitest.config.mts`: `silent` is a non-project option, so
    // setting it there is accepted and then ignored.
    silent: 'passed-only',
  },
});
