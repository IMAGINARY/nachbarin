import { defineProject } from 'vitest/config';

// The operator CLI's unit tests: pure helpers (SQL validation/escaping, wrangler arg building and
// JSON extraction, dispatcher routing). Plain Node — no Workers runtime, no D1 — so it lives in its
// own project rather than the Workers pool. `*.spec.ts` here is resolved relative to scripts/.
export default defineProject({
  test: {
    name: 'scripts',
    environment: 'node',
    include: ['**/*.spec.ts'],
  },
});
