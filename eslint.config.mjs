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
]);
