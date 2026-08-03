# @imaginary-maths/nachbarin-client

Client for [nachbarin](https://github.com/IMAGINARY/nachbarin), a serverless data capture service for museum exhibits.

An exhibit app submits records of visitor interactions; an operator downloads them incrementally. This package is the app's side of that conversation.

## Install

```bash
npm install @imaginary-maths/nachbarin-client
```

Requires any runtime with a global `fetch` — Node 18+, a browser, a Cloudflare Worker, Deno. The package has **zero runtime dependencies** and ships no Node builtins, deliberately: the first-class client is a kiosk browser on a museum floor, and a kiosk's bundle is not a place to smuggle a dependency tree.

## Two clients, because a key is one thing or the other

A key is either `read` or `write`, never both, so there are two factories and no object that carries a half you cannot use.

**There is no `app` or `instance` option, and there will not be one.** The service takes identity and scope from the API key alone — a key grants exactly one installation. Nothing you pass here can widen that.

The wire protocol is specified in [`spec/openapi.yaml`](https://github.com/IMAGINARY/nachbarin/blob/main/spec/openapi.yaml).

### Writing

```js
import { createWriteClient } from '@imaginary-maths/nachbarin-client';

const client = createWriteClient({
  baseUrl: 'https://nachbarin.example.workers.dev',
  apiKey: NACHBARIN_WRITE_KEY,
  engineVersion: 'future-mobility-simulator@1.4.2',
});

// Returns immediately, with the record already durable. Never awaits the network.
client.write({ appData: { choice: 'bus', seconds: 184 } });
```

That is the whole of the normal case. `write()` puts the record in a queue that survives a page reload, returns the `client_id` it minted, and a timer drains the queue in the background — flushing on every write, and otherwise every 60 seconds until there is nothing left.

`client_id` and `created_at` are minted for you. `created_at` is RFC 3339 **with the exhibit's local offset**, never normalized to UTC, because the service takes the date off the front of that string and a UTC date is the wrong day for half the planet every evening. Supply either yourself when the moment being recorded is not the moment of the call:

```js
client.write({
  appData,
  createdAt: '2026-07-15T14:03:22+02:00', // the game ended then; consent came two minutes later
});
```

`write()` throws `ValidationError` — synchronously — for a record the service could never accept: `app_data` over 64 KiB, an empty `engineVersion`, a malformed `clientId`, a `createdAt` that is not a real date. That is a bug in the calling code, and a throw at the call site is the only report that cannot be lost.

`onResult` is available and is **best-effort within this page lifetime**:

```js
client.write({ appData }, { onResult: (r) => console.log(r.status) });
// 'created' | 'duplicate' | 'rejected' | 'evicted'
```

It fires if the record's fate is decided while this client object is still alive, and silently never fires if a reload intervenes first — the callback lives in memory and is not persisted alongside the queue. Do not build anything on it that must not be missed.

### Reading

```js
import { createReadClient } from '@imaginary-maths/nachbarin-client';

const client = createReadClient({ baseUrl, apiKey: NACHBARIN_READ_KEY });

for await (const record of client.listAll()) {
  console.log(record.id, record.created_date, record.app_data);
}
```

`listAll` walks pages for you and stops only when the service says there are no more. `list(params)` gives you one page if you would rather drive the cursor yourself — in which case, **a short page is not the end of the stream**; only `has_more: false` is. Pages get truncated to a response byte budget, and that is normal.

Both accept `afterId`, `limit`, `engineVersion`, `contentVersion` and an `AbortSignal`. Records come back exactly as the service sends them, snake_case and all, with `app_data` untouched.

Records carry **dates and never times** — `created_date` in the exhibit's local frame, `received_date` in UTC. The two are in different frames and may differ by one around midnight; that is a skew smell test, not an error. Exact timestamps are not readable through any key.

## Offline, reloads, and the things that go wrong

The design assumption is a kiosk browser that reloads itself every few minutes, on a machine whose disk is wiped nightly, behind a network that may be down for hours, with nobody present to see an error.

**An interrupted flush is not data loss.** Records leave the queue only when the service acknowledges them, and `client_id` makes re-sending idempotent — so a page that reloads mid-POST simply sends again and gets `duplicate` if the first attempt landed. This is why there is no `sendBeacon` and no unload handler: neither would buy anything.

**The queue is drained after a reload without anyone calling `write()`.** Constructing the client arms the timer if there is anything left over.

### What this client never does

- **It never drops a queued record because of a 4xx.** A 401 means keep retrying, not "my key is bad, discard the day" — a key rotation mid-flight, a wrong `baseUrl`, a captive portal mangling a request are all recoverable, and on hardware wiped nightly there is no upstream copy left to re-send. The one exception is a lone record the service says is too large, which no retry can change.
- **It never treats a 2xx as success on the status alone.** A guest-wifi captive portal answers `200` with a login page. Success requires a body that parses, carries a `results` array, and has one entry per record sent.

`onDiagnostic` reports what is not any single record's business — a failing flush and when the next attempt is, records evicted, a storage backend that stopped working, which random source the ids came from. It is never called with visitor data.

### Options

| Option               | Default                     | What it does                                                                        |
| -------------------- | --------------------------- | ----------------------------------------------------------------------------------- |
| `baseUrl`            | —                           | Service root. A path prefix is kept, so a service behind `/nachbarin` works.        |
| `apiKey`             | —                           | Sent as `Authorization: Bearer`. Never appears in a URL, a message or a diagnostic. |
| `engineVersion`      | — (write, required)         | Default for every record; overridable per record.                                   |
| `contentVersion`     | absent                      | Omit it when the app has no such notion. Do not pass `null` — the two differ.       |
| `fetch`              | global `fetch`              | Pass it **bound**: `globalThis.fetch.bind(globalThis)`.                             |
| `requestTimeoutMs`   | `30_000`                    | Per HTTP request, not per flush.                                                    |
| `flushIntervalMs`    | `60_000`                    | Measured from the last attempt, not the last write.                                 |
| `maxQueueRecords`    | `500`                       | Oldest-out.                                                                         |
| `maxQueueBytes`      | `2 * 1024 * 1024`           | Oldest-out. This is the cap that keeps the queue inside a ~5 MB Web Storage quota.  |
| `maxRecordAgeMs`     | 24 hours                    | Records that have waited longer are dropped unsent.                                 |
| `maxBatchesPerFlush` | `10`                        | Runaway guard; a cycle sends up to 100 records per batch.                           |
| `backoffInitialMs`   | `1_000`                     | Exponential with jitter, honouring `Retry-After` when the service sends one.        |
| `backoffMaxMs`       | `300_000`                   | A multi-hour outage settles here rather than retrying every minute.                 |
| `storage`            | `localStorage`, else memory | Any `{ read(): string \| null; write(value: string): void }`. `null` forces memory. |
| `storageKey`         | `'nachbarin.queue.v1'`      | One live client per key — see below.                                                |
| `newId`              | `crypto.randomUUID` ladder  | Falls back to `getRandomValues`, then `Math.random`. Never throws.                  |
| `newCreatedAt`       | local-offset RFC 3339       | Override if the machine's clock is UTC but its exhibit is not.                      |
| `readRetries`        | `2` (read only)             | Retryable statuses only; every 4xx throws at once.                                  |

The read client is deliberately the opposite of the write client: **the write client never gives up because there is nobody to tell; the read client gives up quickly because there is somebody to tell.**

### Limitations, stated plainly

- **One write client per `storageKey` per origin.** Constructing a second throws. Two clients on one key are two in-memory queues overwriting each other's persisted state — a StrictMode double-mount or a hot reload, and the symptom is records that vanish rather than an error.
- **Cross-tab is not supported.** Two tabs on one key can lose each other's unsent records. Nothing is corrupted by it — anything that was sent is still deduplicated — but a kiosk should run one tab.
- **In Node, a non-empty queue holds the event loop open** until it drains or you call `close()`. That is on purpose: a process exiting while it still owes the service records is the failure this design exists to prevent. `close()` stops the timer and aborts any request in flight.
- **Where `localStorage` is unavailable** — Node, a Worker, a browser told to refuse site data — the queue falls back to memory and does not survive a restart. `onDiagnostic` says so, and `state().persistent` reports it.

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

## Credits

Developed by [Eric Londaits](http://github.com/elondaits) for Imaginary gGmbH.

## License

© 2026 Imaginary gGmbH.

Licensed under the MIT license (see LICENSE)
