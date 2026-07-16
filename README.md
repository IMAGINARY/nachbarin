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

It is written on every POST and read by nobody: there is no endpoint, and no key of any kind reaches it. An operator queries it with `wrangler d1 execute`.

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

`records` and `record_submissions` are written by the service and are not hand-maintained, but the log has no API at all, so everything you do with it is SQL. The recipes are under [Reading the submission log](#reading-the-submission-log).

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

To find out what a key you are about to revoke has been writing — and from where — see [Reading the submission log](#reading-the-submission-log). That is what `key_id` is for.

### Reading the submission log

None of this is reachable over HTTP. Swap `--remote` for `--local` to try any of it against your dev database first.

**The exact time a record was made**, while it is still inside the window:

```sh
npx wrangler d1 execute nachbarin --remote --command \
  "SELECT s.created_at, s.received_at, s.client_ip, s.cf_timezone
   FROM record_submissions s
   JOIN records r ON r.installation_pk = s.installation_pk AND r.client_id = s.client_id
   WHERE r.id = 184002
   ORDER BY s.received_at
   LIMIT 1;"
```

The earliest row is the submission that created the record; any later ones are resends. `created_at` comes back exactly as the exhibit sent it, offset included — compare its offset against `cf_timezone` to find out whether the exhibit's clock is telling the truth.

**Why did this venue stop uploading** — last contact per installation, with the connection it came in on:

```sh
npx wrangler d1 execute nachbarin --remote --command \
  "SELECT i.app_id, i.instance_id, MAX(s.received_at) AS last_seen,
          s.client_ip, s.cf_as_organization, s.cf_colo
   FROM record_submissions s
   JOIN installations i ON i.id = s.installation_pk
   GROUP BY s.installation_pk
   ORDER BY last_seen;"
```

An installation missing from this list has sent nothing in 90 days. A `client_ip` or `cf_as_organization` that changed is a venue that changed ISP.

**The first record from a new venue:**

```sh
npx wrangler d1 execute nachbarin --remote --command \
  "SELECT s.received_at, s.created_at, s.client_ip, s.user_agent
   FROM record_submissions s
   JOIN installations i ON i.id = s.installation_pk
   WHERE i.instance_id = 'museum-x'
   ORDER BY s.received_at LIMIT 1;"
```

**A queue that has stopped draining** — batches where nothing was new. Every `client_id` here already existed, so the exhibit is uploading and storing nothing:

```sh
npx wrangler d1 execute nachbarin --remote --command \
  "SELECT s.submission_id, s.received_at, COUNT(*) AS records, s.client_ip
   FROM record_submissions s
   GROUP BY s.submission_id
   HAVING COUNT(*) > 10
   ORDER BY s.received_at DESC LIMIT 50;"
```

Cross-check a `submission_id` against `records.received_date`: many rows in the log and no matching records means every one came back `duplicate`.

**What has this key been doing** — before revoking it, or after finding it somewhere it should not be:

```sh
npx wrangler d1 execute nachbarin --remote --command \
  "SELECT k.label, s.client_ip, s.cf_country, s.cf_as_organization,
          s.user_agent, COUNT(*) AS records, MIN(s.received_at), MAX(s.received_at)
   FROM record_submissions s
   JOIN api_keys k ON k.id = s.key_id
   WHERE k.label = 'Station 1, north entrance'
   GROUP BY s.client_ip, s.user_agent
   ORDER BY COUNT(*) DESC;"
```

Two IPs where you expected one, an unexpected country, or a `user_agent` that is not the engine are each worth a look. None of them proves anything on its own — a `user_agent` is self-reported — but an attacker who forges one usually forgets the other.

### Erasing a record

Deleting a record does **not** delete its submission log rows, and that is deliberate: the log is the evidence of who sent it, and you delete a vandalised record precisely when that evidence matters. For a genuine erasure request inside the 90-day window, delete both:

```sh
npx wrangler d1 execute nachbarin --remote --command \
  "DELETE FROM record_submissions
   WHERE (installation_pk, client_id) IN (SELECT installation_pk, client_id FROM records WHERE id = 184002);
   DELETE FROM records WHERE id = 184002;"
```

In that order — the log rows are found through the record. Outside the window there is nothing to do: the log rows are already gone. Deleting from `records` leaves a gap in the cursor, which is expected and invisible to readers; `id` is `AUTOINCREMENT`, so the number is never reused.

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
