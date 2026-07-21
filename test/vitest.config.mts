import { fileURLToPath } from 'node:url';
import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';

// The Workers-pool project: every spec here runs inside the real Workers runtime. This used to be the
// repo's whole vitest config; it moved under test/ so the root config can be a plain orchestrator that
// also declares the Node-side scripts/ project (see ../vitest.config.mts). Keeping the Workers vite
// plugin scoped to this file is the point — it must never transform the Node tests.
export default defineWorkersConfig({
  test: {
    name: 'workers',
    // Runs once per test file, before that file's tests — see test/apply-migrations.ts.
    setupFiles: ['./apply-migrations.ts'],
    poolOptions: {
      // A function because the migrations are read from disk, which only Node can do: the setup
      // file runs inside the Workers runtime, which has no filesystem. They are read here and
      // handed across as a test-only binding.
      workers: async () => ({
        wrangler: { configPath: '../wrangler.jsonc' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: await readD1Migrations(fileURLToPath(new URL('../migrations', import.meta.url))),
          },
        },
      }),
    },
  },
});
