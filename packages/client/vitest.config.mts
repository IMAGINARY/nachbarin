import { defineProject } from 'vitest/config';

// The client library's unit tests. Plain Node, like scripts/: `fetch`, `Response`, `Headers` and
// `AbortController` are globals on Node 20+, which is the floor this package declares, so there is
// nothing to emulate and no reason to pay for the Workers pool.
//
// These specs drive the *source*, not `dist/`. Whether the built artifact is consumable — dual
// format, correct conditions, resolvable types — is a packaging question, and publint + attw answer
// it at build time. See the package README for the manual `npm pack` check that covers the rest.
export default defineProject({
  test: {
    name: 'client',
    environment: 'node',
    include: ['**/*.spec.ts'],
  },
});
