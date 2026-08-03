# @imaginary-maths/nachbarin-client

Client for [nachbarin](https://github.com/IMAGINARY/nachbarin), a serverless data capture service for museum exhibits.

An exhibit app submits records of visitor interactions; an operator downloads them incrementally. This package is the app's side of that conversation.

> **Status: infrastructure only.** The packaging is done — dual ESM/CJS, TypeScript declarations, npm publishing. The protocol is not. `createClient` currently does nothing but normalize a URL. Do not depend on this yet.

## Install

```bash
npm install @imaginary-maths/nachbarin-client
```

Requires any runtime with a global `fetch` — Node 18+, a browser, a Cloudflare Worker, Deno. The package has **zero runtime dependencies** and ships no Node builtins, deliberately: the first-class client is a kiosk browser on a museum floor, and a kiosk's bundle is not a place to smuggle a dependency tree.

## Usage

```js
import { createClient } from '@imaginary-maths/nachbarin-client';

const client = createClient({
  baseUrl: 'https://nachbarin.example.workers.dev',
  apiKey: process.env.NACHBARIN_KEY,
});
```

`require('@imaginary-maths/nachbarin-client')` works too, and TypeScript types resolve under both.

**There is no `app` or `instance` option, and there will not be one.** The service takes identity and scope from the API key alone — a key grants exactly one installation and is either `read` or `write`, never both. Nothing you pass here can widen that.

The wire protocol is specified in [`spec/openapi.yaml`](https://github.com/IMAGINARY/nachbarin/blob/main/spec/openapi.yaml).

## Developing against a local checkout

Three tiers, in the order you will want them.

### Daily loop — install from the directory

From the consuming project:

```bash
npm install /path/to/nachbarin/packages/client
```

npm records a `file:` dependency and **symlinks** it, running the package's `prepare` script — so the first install builds `dist/` for you. After that you never reinstall: the symlink points at the live directory, so the whole loop is

```bash
npm run dev:client    # in the nachbarin repo — tsdown --watch
```

Save in the library, and the consumer picks it up on its next run.

npm ≥ 11.6 prints an `allow-scripts` warning on that first install — `1 package has install scripts not yet covered by allowScripts`. Today it is only a warning and `prepare` still runs; npm is clearly heading toward blocking lifecycle scripts by default, so if a future npm skips it, `dist/` will simply be missing. The fix either way is one command in the nachbarin repo:

```bash
npm run build:client
```

Two cautions. **Do not commit the `file:` line** — it encodes your directory layout; use `npm install --no-save <path>` if that matters, accepting that the consumer's next plain `npm install` silently drops the link. And a symlinked package hides three classes of bug: files excluded by `"files"` are still physically present, an undeclared dependency resolves up the monorepo's `node_modules`, and bundlers (Vite pre-bundling, webpack `resolve.symlinks`, Metro) treat links differently from installs.

### Pre-publish gate — pack a tarball

```bash
# in the nachbarin repo
npm pack -w @imaginary-maths/nachbarin-client --pack-destination /tmp

# in the consuming project
npm install /tmp/imaginary-maths-nachbarin-client-0.0.1.tgz
```

`npm pack` runs `prepare`, so the tarball is always fresh. The consumer gets a real extracted copy of exactly the published file set rather than a symlink — the only local option that catches a wrong `"files"` list or an undeclared dependency. It is a gate, not a loop: run it before each publish and after any change to `files`, `exports` or `dependencies`.

### When the consumer's manifest must not change — `npm link`

```bash
cd /path/to/nachbarin/packages/client && npm run build && npm link
cd /path/to/consumer && npm link @imaginary-maths/nachbarin-client
```

Build explicitly here; do not rely on `prepare`. Same symlink blind spots as above, plus one of its own: the link is _global, invisible state_ that any later `npm install` in the consumer can clobber. `npm ls --link --global` to audit, `npm unlink` to clear.

If the consumer ever lives inside the nachbarin repo, skip all of this — add it under `packages/` and depend on `"@imaginary-maths/nachbarin-client": "*"`.

## Releasing

No CI, so this is a manual act from a laptop. npm provenance is therefore unavailable — it requires OIDC from a supported CI.

```bash
npm version <patch|minor|major> -w @imaginary-maths/nachbarin-client
npm run typecheck:client
npx vitest run
npm pack -w @imaginary-maths/nachbarin-client --dry-run   # read the file list before trusting it
npm publish -w @imaginary-maths/nachbarin-client          # publishConfig.access is already "public"
```

`prepublishOnly` re-runs the type-check and tests, and `prepare` rebuilds — but read the `--dry-run` file list yourself. It should be `dist/*`, `package.json`, `README.md`, `LICENSE`, and nothing else.

This package's version is **independent of the service's**. The repo root is `private` and pinned at `0.0.0` permanently; there is nothing to keep in sync.

## License

MIT © IMAGINARY
