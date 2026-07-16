# nachbarin
Serverless data capture service for exhibits

This service provides an API to digital exhibits to capture and store JSON data from visitor interactions for various purposes (statistics, telemetry, visitor surveys, etc.). It is based on Cloudflare Workers.

## Concepts

- **app** — the software module, e.g. `future-mobility-simulator`. Usually named after its GitHub repository.
- **instance** — where it runs: a museum, or one copy of a travelling exhibition. Defaults to `default`.
- **installation** — the `(app, instance)` pair. A record belongs to an installation, and an API key grants exactly one.

An *exhibit* is the whole thing in the museum — furniture, hardware, wall texts, and the app. Only the app talks to this API, which is why nothing here is keyed by "exhibit".

## What gets stored

A record is its `app_data` — an opaque JSON payload the app defines and this service never interprets — plus the least identifying context needed to make it analysable:

| | |
|---|---|
| `id` | Server-assigned, monotonic. Doubles as the download cursor. |
| `installation` | Resolved from the API key, never from the request body. |
| `client_id` | The app's UUID for the record. Deduplicates retries. |
| `created_date` | The **date** the app says it made the record, exhibit-local. |
| `received_date` | The **date** this service took the batch, UTC. |
| `engine_version`, `content_version` | What produced it. |

**Only dates, deliberately.** Apps submit `created_at` as a full RFC 3339 timestamp, and the service keeps only its date. `app_data` is coarse by construction — it records choices, not people — but a precise timestamp is not coarse at all: set beside camera footage or a ticket scan, "this visitor was here at 14:03:22" and "this record was made at 14:03:22" are the same sentence. A date supports every segmentation anyone actually asks for ("how did July compare to June?") without making that inference cheap. The full timestamps live in a separate operator-side metadata table, with different access and its own retention.

This is a real limit, not a guarantee of anonymity: `id` is monotonic, so the order of one installation's records is visible, and someone who knows the opening hours can place a record within its day. Storing dates raises the cost of tying a record to a person; it does not make it impossible.

**`created_date` is local because `created_at` carries its offset.** No timezone is configured anywhere. An app that reports `Z` instead of its real offset gets the UTC date, which can land a day early for the few hours around local midnight — museums are shut then, and an operator who genuinely needs those hours can extract them with SQL against the metadata table.

**`received_date` is how you spot a broken clock.** It comes from the server, so it cannot be wrong; `created_date` comes from the exhibit, so it can. An exhibit whose RTC died reports 1970 forever, and the pair makes that visible long after the metadata table's retention window has closed. The two are in different frames (local vs UTC) and may differ by one around midnight — treat them as a smell test, never an exact difference.

**One write key, one active installation.** Records are deduplicated on `(installation, client_id)`. Installing the same write key in two live installations puts two apps' UUIDs in one namespace; a collision is vanishingly unlikely with UUIDs, but a collision would be reported as `duplicate` — which this protocol defines as success — and the client would drop a record that was never stored. Mint a key per installation.

## Operations

Identity lives in D1, in two hand-maintained tables: `installations` and `api_keys`. There is no admin UI, and deliberately no admin endpoint — this is rare, irreversible work that should be typed on purpose.

### Registering an installation

```sh
npx wrangler d1 execute nachbarin --remote --command \
  "INSERT INTO installations (app_id, instance_id, label)
   VALUES ('future-mobility-simulator', 'museum-x', 'Deutsches Museum, north hall');"
```

`instance_id` may be omitted; it defaults to `'default'`. Both are limited to 100 characters of `[a-zA-Z0-9._-]`: they are typed by hand into commands like the ones on this page and pasted into SQL, where a stray space or quote is invisible in the terminal and produces an identifier that matches nothing.

### Minting a key

Only the sha256 of a key is stored, so **the key is unrecoverable after this** — print it once, hand it over, forget it.

```sh
# 1. 256 bits, base64url, unpadded: safe in an HTTP header and a URL.
#    The leading space keeps it out of shell history (needs HISTCONTROL=ignorespace).
 KEY="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"

# 2. Hash exactly the bytes the Worker will hash.
#    `printf %s` -- NOT `echo`, which appends a newline and produces a completely
#    different hash, and so a key that 401s forever for no visible reason.
 HASH="$(printf %s "$KEY" | shasum -a 256 | cut -d' ' -f1)"

# 3. Store the hash. `kind` is 'write' (deposits records) or 'read' (downloads
#    them); it must be stated, because nothing else in the row implies it.
#    `label` is how you will identify this key later, since the hash tells you
#    nothing.
npx wrangler d1 execute nachbarin --remote --command \
  "INSERT INTO api_keys (key_hash, kind, installation_pk, label)
   SELECT '$HASH', 'write', id, 'Station 1, north entrance'
   FROM installations
   WHERE app_id = 'future-mobility-simulator' AND instance_id = 'museum-x';"

# 4. Print it once and hand it over via a secure channel.
 echo "$KEY"
```

The `SELECT ... FROM installations WHERE` form means you name the installation the way you think of it and never look up its surrogate id; if the pair does not exist, zero rows are inserted rather than the wrong ones.

A **read key** is minted exactly the same way, with `'read'` in place of `'write'`:

```sh
npx wrangler d1 execute nachbarin --remote --command \
  "INSERT INTO api_keys (key_hash, kind, installation_pk, label)
   SELECT '$HASH', 'read', id, 'Operator download, north hall'
   FROM installations
   WHERE app_id = 'future-mobility-simulator' AND instance_id = 'museum-x';"
```

Every key grants exactly one installation, whatever its kind, and `installation_pk` is `NOT NULL` — so an omitted installation is an error rather than a key with more reach than you meant. A read key downloads that one installation's records: `GET /v1/records` takes no `?app=` or `?instance=`, because the key already settles the question.

### Exporting across installations

There is deliberately no key that spans installations. A cross-installation export is a query run by hand, not a credential:

```sh
npx wrangler d1 execute nachbarin --remote --json --command \
  "SELECT i.app_id, i.instance_id, r.created_date, r.engine_version, r.app_data
   FROM records r
   JOIN installations i ON i.id = r.installation_pk
   WHERE r.created_date BETWEEN '2026-07-01' AND '2026-07-31'
   ORDER BY r.id;" > export.json
```

`app_data` is JSON in a text column, so SQLite's JSON functions work on it directly — `json_extract(r.app_data, '$.nodes')` and friends. A `CHECK (json_valid(app_data))` on the table means an export can never die partway through on a row that will not parse.

This is rare work that belongs next to the rest of the hand-typed SQL on this page. A token that spanned installations would be a standing one: it lives on someone's laptop, in a CI variable, in a chat log, and reads every museum's data for as long as it exists. Running the query needs database access at the moment you need it, and leaves nothing behind.

### Revoking a key

Revocation is a soft delete: the row stays, so the hash can never be re-issued and you keep the record of what existed. Rotation is insert-new → hand over → revoke-old.

```sh
npx wrangler d1 execute nachbarin --remote --command \
  "UPDATE api_keys SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE label = 'Station 1, north entrance';"
```

A revoked key answers `401`, identically to a key that never existed.

### Schema changes

Migrations live in `migrations/` and are applied with `wrangler d1 migrations apply`. **There are no down-migrations** — a `--remote` apply cannot be undone, so try it locally first.

```sh
npm run db:migrate:local                                  # local, safe
npx wrangler d1 migrations apply nachbarin --remote       # production, one-way
```

## Credits

Developed by [Eric Londaits](http://github.com/elondaits) for Imaginary gGmbH.

## License

© 2026 Imaginary gGmbH.

Licensed under the MIT license (see LICENSE)
