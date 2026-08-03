// @ts-check

import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig([
  // `packages/*/dist/` is build output, and with `projectService` an ignore is the only thing that
  // keeps it out: a file in no tsconfig and in no `allowDefaultProject` entry is a hard parser
  // error, not a skipped file. Without this line the first `npm run build:client` breaks lint.
  globalIgnores(['.wrangler/', 'worker-configuration.d.ts', 'packages/*/dist/']),
  {
    files: ['**/*.{js,mjs,cjs,ts,mts,cts}'],
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        // src/, test/, scripts/ and packages/client/ each have a tsconfig; the project service
        // resolves their files automatically. These config files belong to no tsconfig, so they
        // need a default project — every one of them is `.mts`, and that is not a coincidence: a
        // tsconfig `include` of `./**/*.ts` is a literal-suffix glob that does not match `.mts`.
        // So `packages/client/tsdown.config.ts` must NOT be listed (it *is* in a project, and
        // typescript-eslint errors on a file that is in both), while the `.mts` beside it must be.
        projectService: {
          allowDefaultProject: [
            '*.mjs',
            '*.mts',
            'test/vitest.config.mts',
            'scripts/vitest.config.mts',
            'scripts/e2e/vitest.config.mts',
            'packages/client/vitest.config.mts',
          ],
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
  {
    // The published client. A separate block from the `src/` one above, because that block's reason
    // is Workers Logs indexing and it does not transfer: here the rule is simply that a library does
    // not print. Whatever this package has to say it says by returning a value or throwing — the
    // consumer owns stdout, and there is no `observability.ts` to route through.
    //
    // `no-restricted-globals` is the other half of `lib: ["DOM"]` in packages/client/tsconfig.json.
    // DOM is how `fetch` gets its types without dragging in @types/node; the price is that it also
    // declares a browser's globals. None of these exist in Node, in a Worker or in Deno, and the
    // whole point of this package is that it runs in all of them.
    files: ['packages/client/src/**/*.ts'],
    ignores: ['packages/client/src/**/*.spec.ts'],
    rules: {
      'no-console': 'error',
      'no-restricted-globals': [
        'error',
        ...['window', 'document', 'localStorage', 'sessionStorage', 'navigator', 'alert'].map((name) => ({
          name,
          message: 'The client must also run in Node, Workers and Deno — `lib: ["DOM"]` offers this, but it is not portable.',
        })),
      ],
    },
  },
]);
