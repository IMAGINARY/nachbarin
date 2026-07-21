import { defineConfig } from 'vitest/config';

// Orchestrator only. Two projects with different runtimes, one per config file so each keeps its own
// plugins/pool: `test/` runs in the Workers pool (see test/vitest.config.mts), `scripts/` runs in plain
// Node (see scripts/vitest.config.mts). `npx vitest run` executes both.
export default defineConfig({
  test: {
    projects: ['./test/vitest.config.mts', './scripts/vitest.config.mts'],
  },
});
