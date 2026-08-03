/**
 * The machine-readable failure vocabulary, alone in a file with no imports.
 *
 * This lives apart from `http.ts` — where it is used and from where the type is re-exported — for
 * one reason: `packages/client/` re-declares the wire contract and pins it with a parity spec, and
 * that spec has to *value*-import this array to compare it. The client's tsconfig sets `types: []`
 * and `lib: ["DOM"]`, so anything it reaches into is type-checked without the Workers types. Left in
 * `http.ts`, `ERROR_CODES` would drag `Response`, `Request`, `ReadableStream` and `TextDecoder` in
 * with it, at both typecheck and runtime.
 *
 * Hence the rule this file exists to satisfy: **the client's parity spec may only import `src/`
 * modules that have no imports of their own and name no ambient global.** This one and `config.ts`
 * qualify; keep it that way.
 *
 * An array rather than a bare union because a union has no runtime existence, and a parity check
 * that only a type-checker can see is not a failing test — `npx vitest run` would stay green while
 * the contract drifted.
 */

export const ERROR_CODES = [
  'invalid_json',
  'invalid_request',
  'invalid_field',
  'batch_too_large',
  'unauthorized',
  'forbidden',
  'not_found',
  'method_not_allowed',
  'payload_too_large',
  'unsupported_media_type',
  'internal_error',
  'unavailable',
] as const;

/**
 * `error` is always one of these, at the top level and inside a per-record result alike. Human prose
 * lives in a separate `message` field, so clients branch on a stable code and messages stay free to
 * be reworded.
 */
export type ErrorCode = (typeof ERROR_CODES)[number];
