import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// End-to-end suite for the operator CLI: each spec file spawns the real `node scripts/cli.ts` against
// its own throwaway local D1 — a temp `--persist-to` directory, migrated in beforeAll (see harness.ts).
// Deliberately NOT a project in the root vitest.config.mts: every test costs seconds of wrangler
// spawns, so it runs only via `npm run test:e2e`. Timeouts are sized for wrangler, not for vitest's
// 5-second defaults; fileParallelism is off so wrangler spawns don't pile up (correctness does not
// depend on it — each file has its own database).
export default defineConfig({
  test: {
    name: 'scripts-e2e',
    environment: 'node',
    dir: fileURLToPath(new URL('.', import.meta.url)),
    include: ['**/*.e2e.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
