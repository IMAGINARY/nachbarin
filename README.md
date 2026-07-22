# nachbarin

Serverless data capture service for exhibits

This service provides an API to digital exhibits to capture and store JSON data from visitor interactions for various purposes (statistics, telemetry, visitor surveys, etc.). It is based on Cloudflare Workers.

Nachbarin is the friendly neighbor that receives your payloads and keeps them safe until you go look for them. According to German folklore, a superior option to postboxes and lockers. The unsung hero holding the fabric of society together, one parcel at a time.

## Concepts

- **app** — the software module, e.g. `future-mobility-simulator`. Usually named after its GitHub repository.
- **instance** — where it runs: a museum, or one copy of a travelling exhibition. Defaults to `default`.
- **installation** — the `(app, instance)` pair. A record belongs to an installation, and an API key grants exactly one.

An _exhibit_ is the whole thing in the museum — furniture, hardware, wall texts, and the app. Only the app talks to this API, which is why nothing here is keyed by "exhibit".

## What gets stored

A record is its `app_data` — an opaque JSON payload the app defines and this service never interprets — plus the least identifying context needed to make it analysable:

|                                     |                                                              |
| ----------------------------------- | ------------------------------------------------------------ |
| `id`                                | Server-assigned, monotonic. Doubles as the download cursor.  |
| `installation`                      | Resolved from the API key, never from the request body.      |
| `client_id`                         | The app's UUID for the record. Deduplicates retries.         |
| `created_date`                      | The **date** the app says it made the record, exhibit-local. |
| `received_date`                     | The **date** this service took the batch, UTC.               |
| `engine_version`, `content_version` | What produced it.                                            |

**Only dates, deliberately.** Apps submit `created_at` as a full RFC 3339 timestamp, and the service keeps only its date. `app_data` is coarse by construction — it records choices, not people — but a precise timestamp is not coarse at all: set beside camera footage or a ticket scan, "this visitor was here at 14:03:22" and "this record was made at 14:03:22" are the same sentence. A date supports every segmentation anyone actually asks for ("how did July compare to June?") without making that inference cheap. The full timestamps live in `record_submissions` — operator-only, never on the wire, deleted after 90 days. See [The submission log](#the-submission-log).

This is a real limit, not a guarantee of anonymity: `id` is monotonic, so the order of one installation's records is visible, and someone who knows the opening hours can place a record within its day. Storing dates raises the cost of tying a record to a person; it does not make it impossible.

**`created_date` is local because `created_at` carries its offset.** No timezone is configured anywhere. An app that reports `Z` instead of its real offset gets the UTC date, which can land a day early for the few hours around local midnight — museums are shut then, and an operator who genuinely needs those hours can extract them with SQL against `record_submissions`, which keeps both the offset as sent and the timezone the edge resolved from the IP.

**`received_date` is how you spot a broken clock.** It comes from the server, so it cannot be wrong; `created_date` comes from the exhibit, so it can. An exhibit whose RTC died reports 1970 forever, and the pair makes that visible long after the submission log's retention window has closed. The two are in different frames (local vs UTC) and may differ by one around midnight — treat them as a smell test, never an exact difference.

**One write key, one active installation.** Records are deduplicated on `(installation, client_id)`. Installing the same write key in two live installations puts two apps' UUIDs in one namespace; a collision is vanishingly unlikely with UUIDs, but a collision would be reported as `duplicate` — which this protocol defines as success — and the client would drop a record that was never stored. Mint a key per installation.

## The submission log

`record_submissions` is where everything `records` refuses to keep goes: the exact timestamps, and what the edge knew about the connection. It answers the questions you only ask when something is wrong — _why did this exhibit stop uploading, what was the first record from the new venue, where did this batch actually come from._

It is written on every POST and read by nobody: there is no endpoint, and no key of any kind reaches it. An operator reads it out of band, with the `log` subcommands of the CLI (see [Operations](#operations)).

**One row per record per POST, including duplicates.** This is a log of submissions, not metadata attached to a record — a resubmission stores no record (`ON CONFLICT DO NOTHING`) but still gets a row. That is the point: an exhibit whose queue has stopped draining, a batch replayed from a different address, and a client resending one `client_id` with different `app_data` all produce no record at all, and would otherwise leave no trace anywhere. Per-record metadata is still available as a view — the earliest row for an `(installation, client_id)` is the submission that created the record.

| Column                             | Meaning                                                             |
| ---------------------------------- | ------------------------------------------------------------------- |
| `submission_id`                    | One UUID per POST. `GROUP BY` it to see a batch as a batch.         |
| `installation_pk`, `key_id`        | Which installation, and **which key** — keys outlive their labels.  |
| `client_id`                        | Joins to `records` with `installation_pk`.                          |
| `created_at`                       | The client's timestamp **verbatim**, offset and all.                |
| `received_at`                      | Full precision, UTC. The retention clock.                           |
| `client_ip`, `user_agent`          | The exhibit's address, and what claims to be talking to us.         |
| `cf_country`, `cf_city`, `cf_colo` | Where the edge resolved it, and which datacenter took it.           |
| `cf_asn`, `cf_as_organization`     | The ISP, as a number and as a name.                                 |
| `cf_timezone`                      | IANA name from the **IP** — independent of what the exhibit claims. |

**What this table is, and is not.** The IP and geo describe the exhibit's building and its ISP — a cable and an address already on the museum's website. They are not about visitors. The field that makes this table sensitive is the precise `created_at`, and that is what the 90-day window and the operator-only access are for. There is deliberately no latitude, longitude or postal code: IP geolocation returns an ISP's centroid rather than a position, so they add nothing over `cf_city` while looking like they add a great deal.

**Retention is automatic.** A cron trigger deletes rows past 90 days (`METADATA_RETENTION_DAYS` in `src/config.ts`) every night. It will not ask, and nothing else in this repo depends on someone remembering it — the date-only design of `records` is only honest as long as this runs.

Deleting a _record_ does not delete its log rows: there is no foreign key, deliberately, because you delete a vandalised record precisely when you want to keep the evidence of who sent it. Within the window, an erasure request needs the companion `DELETE` in [Erasing a record](#erasing-a-record).

## Operations

Identity lives in D1, in two hand-maintained tables: `installations` and `api_keys`. There is no admin UI, and deliberately no admin endpoint — this is rare, irreversible work that should be typed on purpose.

The operator CLI in `scripts/` is how that work is done. Run it as `node scripts/cli.ts <command> <subcommand>` — or `npm run admin -- <command> <subcommand>` — and `--help` lists the whole surface. It is a thin, audited wrapper over `wrangler d1 execute` and reuses your `wrangler login`: because wrangler has no parameter binding, the CLI validates every identifier and escapes every label in one place, generates keys in-process so they never touch the shell, and enforces the load-bearing statement orders below.

**`--local` is the default; `--remote` must be typed.** Every command runs against the local dev database unless you pass `--remote`, mirroring the deliberate absence of a `db:migrate:remote` script — try a command locally, then repeat it with `--remote`. The destructive commands — `installation delete`, `key revoke`, `record erase` — additionally demand a typed confirmation on `--remote` (and `installation delete --cascade` demands one even locally). The minted key and query results go to stdout; every prompt and human-facing notice goes to stderr, so redirecting stdout captures exactly the data.

`records` and `record_submissions` are written by the service, not hand-maintained: `records` is reachable through `record erase` and `export records`, and the submission log — which has no API at all — is read through the `log` subcommands. For a query the CLI does not parameterize, the raw SQL lives in [docs/operations.md](docs/operations.md).

### Registering an installation

```sh
node scripts/cli.ts installation create \
  --app future-mobility-simulator --instance museum-x \
  --label "Deutsches Museum, north hall" --remote
```

`--instance` may be omitted; it defaults to `default`. Both ids are limited to 100 characters of `[a-zA-Z0-9._-]` — they are typed by hand and, being identifiers, must match exactly; anything expressive belongs in `--label`. The CLI rejects an out-of-charset id before it reaches SQL, and re-registering an existing pair is a plain `already exists` rather than a raw constraint error.

`installation list` prints the full inventory — every pair with its record, key (active/revoked), and submission counts. `installation delete --app … --instance …` removes one, but refuses while any records, keys, or log rows remain; `--cascade` forces it and destroys all of them, including the forensic log and deliberately-kept revoked-key history, so it is only ever for an installation created by mistake — never for decommissioning a venue.

### Minting a key

Only the sha256 of a key is stored, so **the key is unrecoverable after this** — it is printed once, to stdout, and never again.

```sh
node scripts/cli.ts key mint \
  --app future-mobility-simulator --instance museum-x \
  --kind write --label "Station 1, north entrance" --remote
```

`--kind` is `write` (deposits records) or `read` (downloads them) and must be stated, because nothing else in the row implies it. `--label` is how you will identify this key later, since the hash tells you nothing. The key is generated in-process and prints alone on stdout, so `key mint … --remote > key.txt` captures exactly the key and nothing else; hand it over via a secure channel and delete the file. The old `printf`-vs-`echo` hashing trap — where `echo`'s trailing newline silently minted a key that 401s forever — is gone by construction here, because the key never passes through the shell.

You name the installation the way you think of it; if the `(app, instance)` pair does not exist, the CLI mints nothing and says so, rather than inventing a key with more reach than you meant.

A **read key** is minted identically, with `--kind read`:

```sh
node scripts/cli.ts key mint \
  --app future-mobility-simulator --instance museum-x \
  --kind read --label "Operator download, north hall" --remote
```

Every key grants exactly one installation, whatever its kind. A read key downloads that one installation's records: `GET /v1/records` takes no `?app=` or `?instance=`, because the key already settles the question.

`key list --app … --instance …` shows every key for an installation — its id, kind, creation time, and revocation state — but never the hash, which is not a key and is useless as one.

### Exporting across installations

There is deliberately no key that spans installations. A cross-installation export is a query run by hand, not a credential:

```sh
node scripts/cli.ts export records --from 2026-07-01 --to 2026-07-31 --remote > export.ndjson
```

`--from`/`--to` bound `created_date`; either may be omitted for an open-ended range, and both omitted exports the whole corpus. Output is NDJSON — one record per line — to stdout, with the count on stderr so it never pollutes the data; pass `--json` for a single pretty-printed array instead. Each record's `app_data` comes back as a real JSON value, not a string, so the file is directly consumable.

A token that spanned installations would be a standing credential — on a laptop, in a CI variable, in a chat log — reading every museum's data for as long as it exists. Running the export needs database access at the moment you need it, and leaves nothing behind. For a shape the CLI does not offer — a different projection, a join, or `json_extract(app_data, '$.nodes')` over the payload — adapt the raw query in [docs/operations.md](docs/operations.md); `app_data` is JSON in a text column with a `CHECK (json_valid(...))`, so SQLite's JSON functions work on it directly and an export can never die partway on a row that will not parse.

### Revoking a key

Revocation is a soft delete: the row stays, so the hash can never be re-issued and you keep the record of what existed. Rotation is mint-new → hand over → revoke-old.

```sh
node scripts/cli.ts key revoke \
  --app future-mobility-simulator --instance museum-x \
  --label "Station 1, north entrance" --remote
```

Select the key by `--label` within its installation, or by `--id` (from `key list`) when a label matches more than one. On `--remote` the CLI names the matching keys and asks you to retype the target before it writes. A revoked key answers `401`, identically to a key that never existed.

To find out what a key you are about to revoke has been writing — and from where — see `log key-activity` under [Reading the submission log](#reading-the-submission-log). That is what `key_id` is for.

### Reading the submission log

The log has no HTTP endpoint; the `log` subcommands are the only structured way to read it, and swapping `--remote` for `--local` (the default) tries any of them against your dev database first. Each only renders what it finds — it never "cleans up" the verbatim edge data, because a value that looks wrong in a forensic table is the point of the table.

**The exact time a record was made**, while it is still inside the window:

```sh
node scripts/cli.ts log record-time --id 184002 --remote
```

The earliest row is the submission that created the record; any later ones are resends. `CREATED_AT` comes back exactly as the exhibit sent it, offset included — compare its offset against `TIMEZONE` (resolved from the IP, independent of the exhibit's claim) to find out whether the exhibit's clock is telling the truth.

**Why did this venue stop uploading** — last contact per installation, with the connection it came in on:

```sh
node scripts/cli.ts log last-seen --remote
```

An installation missing from this list has sent nothing in 90 days. An `IP` or `ISP` that changed is a venue that changed connection.

**The first record from a new venue:**

```sh
node scripts/cli.ts log first-record \
  --app future-mobility-simulator --instance museum-x --remote
```

**A queue that has stopped draining** — batches where an unusually large number of records arrived and, likely, nothing was new. If every `client_id` already existed, the exhibit is uploading and storing nothing:

```sh
node scripts/cli.ts log stale-batches --remote          # threshold is --min 10 by default
```

Cross-check a `SUBMISSION_ID` against `records.received_date` (see [docs/operations.md](docs/operations.md)): many rows in the log and no matching records means every one came back `duplicate`.

**What has this key been doing** — before revoking it, or after finding it somewhere it should not be:

```sh
node scripts/cli.ts log key-activity \
  --app future-mobility-simulator --instance museum-x \
  --label "Station 1, north entrance" --remote
```

Select the key by `--label`/`--app` or by `--id`, exactly as `key revoke` does. Two IPs where you expected one, an unexpected country, or a `USER_AGENT` that is not the engine are each worth a look. None of them proves anything on its own — a user agent is self-reported — but an attacker who forges one usually forgets the other.

These cover the common questions; for an ad-hoc filter the subcommands do not expose, the underlying SQL is in [docs/operations.md](docs/operations.md).

### Erasing a record

Deleting a record does **not** delete its submission log rows, and that is deliberate: the log is the evidence of who sent it, and you delete a vandalised record precisely when that evidence matters. For a genuine erasure request inside the 90-day window, `record erase` removes both:

```sh
node scripts/cli.ts record erase --id 184002 --remote
```

It deletes the log rows first — they are located through the record — and the record second, an order the CLI enforces so it cannot be got wrong. On `--remote` it reports how many log rows will go and asks you to retype the id before writing. Outside the window there is nothing extra to do: the log rows are already gone. Deleting from `records` leaves a gap in the cursor, which is expected and invisible to readers; `id` is `AUTOINCREMENT`, so the number is never reused.

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
