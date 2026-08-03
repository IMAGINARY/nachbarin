import { defineConfig } from 'tsdown';

// Both validators below inspect the package by *packing* it: tsdown shells out to `npm pack` into a
// temp directory and hands them the tarball. That breaks when the build is itself running inside a
// dry run — `npm pack --dry-run` and `npm publish --dry-run` both trigger `prepare` and both export
// `npm_config_dry_run=true` into it, the inner pack inherits it and writes no file, and tsdown fails
// with "Failed to find packed tarball". So without this guard the two commands you would reach for
// to check a release before making it are the two that cannot complete.
//
// Skipping validation for those runs costs nothing: a dry run produces no artifact to validate, and
// a real `npm pack`/`npm publish` still gets the full check. Guard *both* — it is the pack step they
// share that fails, so disabling only one still leaves the other to trip it.
//
// `process` is deliberately not typed in this package (tsconfig.json sets `types: []`, so the
// *library* cannot reach for Node globals). This is the build config rather than the library, so
// reading one variable is fine — it just has to be spelled without those declarations.
const isNpmDryRun = Boolean((globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.npm_config_dry_run);

// One bundled ESM file, one bundled CJS file, and a declaration file for each — the three ways a
// consumer can pick this up (`import`, `require`, TypeScript). The filenames follow from
// `"type": "module"` in package.json: ESM keeps `.js`, CJS becomes `.cjs`, and the dts plugin
// derives `.d.ts`/`.d.cts` from those. The hand-written `exports` map spells the same four paths
// out; `publint` is what keeps the two from drifting.
//
// The map is hand-written rather than generated (`exports: true`) on purpose: tsdown's generator
// rewrites the git-tracked package.json as a build step, which — with `prepare` wired to the build
// — would let a plain `npm install` dirty a tracked file. It also omits the per-condition `types`
// below, falling back to file adjacency. Nine lines that will never change are not worth either.
export default defineConfig({
  entry: ['./src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,

  // The clients are kiosk browsers on museum floors, and whatever runtime the next exhibit uses.
  // `neutral` is the only platform that asserts nothing: no `node:` builtin resolution, no browser
  // field, global `fetch` only.
  platform: 'neutral',

  // Explicit, and it has to be. Left unset, tsdown reads `engines.node` from package.json and
  // lowers to `node20` — a floor that describes one of the four runtimes this ships to and says
  // nothing about the browsers that are the actual constraint.
  target: 'es2022',

  sourcemap: true,
  clean: true,

  // There is no CI, so publishing is a manual act from a laptop and these two are the only
  // pre-flight check there is. publint validates the exports map against the files actually
  // emitted; attw resolves the package the way node10 / node16 / bundler consumers each would and
  // fails on a types/runtime mismatch.
  //
  // They matter more than they look: the build itself does *not* type-check the source (the dts
  // path passes `forceDtsEmit`, which makes TypeScript skip checking), so `npm run typecheck` and
  // these two are the whole safety net.
  publint: !isNpmDryRun,
  attw: !isNpmDryRun,
});
