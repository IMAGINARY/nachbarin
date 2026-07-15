import { fileURLToPath } from 'node:url';
import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    // Runs once per test file, before that file's tests — see test/apply-migrations.ts.
    setupFiles: ['./test/apply-migrations.ts'],
    poolOptions: {
      // A function because the migrations are read from disk, which only Node can do: the setup
      // file runs inside the Workers runtime, which has no filesystem. They are read here and
      // handed across as a test-only binding.
      workers: async () => ({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: await readD1Migrations(fileURLToPath(new URL('migrations', import.meta.url))),
          },
        },
      }),
    },
  },
});
