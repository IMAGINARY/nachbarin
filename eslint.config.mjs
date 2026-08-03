// @ts-check

import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig([
  globalIgnores(['.wrangler/', 'worker-configuration.d.ts']),
  {
    files: ['**/*.{js,mjs,cjs,ts,mts,cts}'],
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        // src/, test/ and scripts/ each have a tsconfig; the project service resolves their files
        // automatically. These config files belong to no tsconfig, so they need a default project.
        projectService: {
          allowDefaultProject: ['*.mjs', '*.mts', 'test/vitest.config.mts', 'scripts/vitest.config.mts', 'scripts/e2e/vitest.config.mts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      // `interface ProvidedEnv extends Env {}` in test/env.d.ts is declaration merging, not a redundant type.
      '@typescript-eslint/no-empty-object-type': ['error', { allowInterfaces: 'with-single-extends' }],
    },
  },
  {
    // Workers Logs indexes the fields of a lone object argument and nothing else, so a stray
    // `console.log('msg', { … })` in the Worker is silently unqueryable rather than wrong-looking.
    // Routing every call through one module is what makes that rule checkable — see `observability.ts`.
    // Scoped to `src/`: `test/` prints freely and `scripts/` writes through `process.stdout`.
    files: ['src/**/*.ts'],
    rules: { 'no-console': 'error' },
  },
  {
    files: ['src/observability.ts'],
    rules: { 'no-console': 'off' },
  },
]);
