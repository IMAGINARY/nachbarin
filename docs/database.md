# Database

The current schema and the reasoning behind it, in one place — read this instead of the migration
sequence.

**Based on migrations through `0004_log_record_submissions.sql`.** If `migrations/` contains
anything later, this document predates it and needs updating.

`migrations/` is append-only history: applied migration SQL is never edited, so an individual
migration may describe a decision a later one reversed (`0002` rebuilt `api_keys`, for example).
Where two migrations disagree, the later one wins; where a migration and this document disagree,
check the migration numbers and trust the newer account. To compare against a live database:

```sh
npx wrangler d1 execute nachbarin --local --command "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL"
```

## Overview

Four tables:

```
installations 1──< api_keys             every key grants exactly one installation
installations 1──< records              UNIQUE (installation_pk, client_id) is the dedupe
installations 1──< record_submissions   no FK to records, by design
```

- **`installations`** — one row per `(app_id, instance_id)` pair; the identity everything hangs off.
- **`api_keys`** — sha256-hashed credentials, `kind` in `read`/`write`, each scoped to one installation.
- **`records`** — the payload corpus the API serves. Stores **dates, never times**.
- **`record_submissions`** — operator-only forensics log: full timestamps and edge data, swept at 90 days.

All timestamp columns are RFC 3339 TEXT in UTC (SQLite has no date type). The
`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` defaults emit byte-identical strings to
`Date.prototype.toISOString()` output, and the format sorts lexicographically in clock order —
which is what makes the retention sweep's `<` comparison chronological.

## installations

One row per `(app_id, instance_id)` pair. `app_id` is the software module (usually a GitHub
repository name), never the physical exhibit; `instance_id` is where it runs and defaults to
`'default'` because most apps are installed exactly once.

- **Surrogate `id`** (no AUTOINCREMENT — the inbound FKs already prevent a reused rowid from
  dangling). References use the integer so renaming an app or instance is a one-row UPDATE, and it
  is what makes the dedupe key unambiguous: `instance_id` scopes nothing alone.
- **Charset CHECKs** restrict both ids to the GitHub-repo-name charset: the values are typed by
  hand into shell commands and SQL, where a stray space is invisible. Anything expressive goes in
  `label` — the pair is an identifier, but a renameable one: `installation edit` updates it in
  place, and every key, record, and log row follows the surrogate id.

## api_keys

Bearer-token credentials. Identity and scope come from the key alone — never the request body or
query string.

- **`key_hash`** — sha256 of the key, lowercase hex, exactly what
  `printf %s "$key" | shasum -a 256` prints (`echo` appends a newline and mints a key that 401s
  forever — `key mint` hashes in-process to sidestep this, so mint through the CLI; see README
  "Minting a key"). The key itself is never stored. Comparison is BINARY, so the format CHECK turns a
  mis-cased or padded hash into a loud INSERT error instead of a credential that never matches.
- **`kind`** — `read` or `write`. Not derivable from anything: both kinds carry an installation, so
  this column is the only thing separating a key that may download from one that may only deposit.
- **`installation_pk`** — `NOT NULL`: every key is scoped to exactly one installation, and there is
  no global read key. Read scope is authorization, not a filter — `GET /v1/records` takes no
  app/instance parameters. Full-corpus export is a hand-typed operator query (README "Exporting
  across installations"), deliberately not an API capability. `ON DELETE RESTRICT`: deleting an
  installation must not quietly destroy its credential trail.
- **`label`** — close to load-bearing: the hash is one-way, so this note is the only way to tell
  keys apart when one station's key must be revoked and not the others.
- **`revoked_at`** — revocation is a soft delete. The row is audit evidence and reserves the hash
  forever; every reader must filter `WHERE revoked_at IS NULL`. A revoked key and an unknown key
  both answer 401, indistinguishably, on purpose.

## records

What the API writes and serves. One row per deduplicated record.

- **Dates, never times — this is the design, not an omission.** `app_data` is coarse by
  construction, but a precise timestamp set against camera footage or a ticket scan identifies who
  made which choice. The exact times live in `record_submissions`, behind different access and a
  90-day retention. Do not add a timestamp column here or return one from `GET`
  (`test/records.get.spec.ts` fails if a time reaches the wire).
- **`id`** — `AUTOINCREMENT`, because it is the public download cursor: without it, deleting the
  highest row (vandalism cleanup, erasure requests — this table gets deletions) lets the next
  insert reuse that id, and a reader already paged past it would silently never see the
  replacement. Gaps are normal and meaningless; `after_id` is an exclusive lower bound. Never
  count ids or infer corpus size from the newest one.
- **`client_id`** — the client's UUID and the idempotency key. Lowercased by validation; the CHECK
  guards other write paths, because an uppercase spelling would dodge the UNIQUE and double-store.
- **`created_date`** — the date of the client's `created_at` in the exhibit's **local** frame. A
  `slice(0, 10)`, valid because `created_at` carries its offset and is never normalized to UTC
  (`localDateOf` in `validation.ts`). Trusted only as far as the exhibit's clock.
- **`received_date`** — the server's UTC date, one value per batch. Keeps a broken exhibit clock
  detectable after the submission log's retention has passed. The two dates are in different
  frames and may differ by one around midnight — a skew smell test, never an exact difference.
- **`app_data`** — opaque JSON text, never interpreted. `NOT NULL` is load-bearing: a JSON `null`
  payload must be stored as the text `null`; SQL NULL would mean "no payload", which the protocol
  cannot express. `CHECK (json_valid(...))` exists because `list` JSON.parses every row and pages
  are id-ordered — one unparseable row would wedge the download at that cursor permanently.
- **`UNIQUE (installation_pk, client_id)`** — the dedupe, scoped to the installation pair and never
  to `instance_id` alone (it defaults to `default`; two apps at one instance would collide, and
  `duplicate` means success, so the collision would silently drop records). The insert path relies
  on this constraint (`ON CONFLICT DO NOTHING`), not a preceding SELECT. Operational consequence:
  one write key must never serve two active installations.
- **`records_by_installation (installation_pk, id)`** — serves the pager
  (`WHERE installation_pk = ? AND id > ? ORDER BY id LIMIT ?`) as a direct seek plus walk.
  Deliberately no index on the version columns.

## record_submissions

The forensics log: who sent what, from where, and exactly when. No endpoint — operator SQL only —
and swept at 90 days by cron (`scheduled` in `index.ts` → `purgeExpiredSubmissions`, which must
never touch `records`; `test/retention.spec.ts` pins the boundary). The date-only design of
`records` depends on this sweep running: if it stops, the table becomes a permanent
precise-timestamp archive.

- **Grain: one row per submitted record per POST, duplicates included.** `records` dedupes
  silently, so a resubmission stores nothing — yet a queue that stopped draining, a replayed
  batch, or a resend with mutated `app_data` is exactly what this table exists to reveal, and all
  three happen without a record being created. Per-record metadata is a view over the log: the
  earliest row per `(installation_pk, client_id)` is the creating submission.
- **No `record_id`, no FK to `records`.** The natural key joins back without coupling the two
  inserts (`ON CONFLICT DO NOTHING` returns no id). Both FK behaviours would be wrong: RESTRICT
  blocks the deletions `records` expects; CASCADE destroys the evidence of who sent a record at
  the moment it is deleted on suspicion. A log row outliving its record is the feature.
- **Every CHECK must already be guaranteed by the code** (`validation.ts`, `provenance.ts`,
  `crypto.randomUUID`). The rows share the record insert's transaction, so a CHECK that fires is a
  rolled-back batch → 500 → retry → 500, forever. Edge-sourced values are bounded (clamped in
  `provenance.ts` first), never shape-checked. The sharpest case: validation accepts lowercase
  `t`/`z` and unbounded fractional seconds and returns `created_at` verbatim, so its CHECK uses
  `[Tt]` and pins no length. A forensics table must not refuse a row because it looks wrong —
  looking wrong is the point.
- **Cap:** at most `MAX_SUBMISSIONS_PER_RECORD` rows per `(installation, client_id)`
  (`src/config.ts`), enforced as a `WHERE` folded into `INSERT_SUBMISSION_SQL` — not a CHECK,
  which would roll back the batch. The cap is invisible to the client (a capped submission is
  still reported `duplicate`) and can only withhold a row from a submission that stored nothing.
  It is flat rather than per-day because exhibits reset nightly and lose their queue; if that
  changes, the cap must become per-day.
- **Columns of note:** `submission_id` is one UUID per POST (not derivable from timestamps —
  Workers freezes the clock during synchronous execution, so concurrent POSTs can carry identical
  `received_at`). `key_id` records _which_ key wrote, making incident revocation surgical.
  `created_at` is byte-for-byte as sent, offset and all. `received_at` is the sweep's clock —
  retention measured from when we heard, not from a client clock a dead RTC reports as 1970.
  `cf_timezone` is derived from the IP independently of the exhibit's claims, so `created_at`'s
  offset becomes checkable and local wall-clock is recoverable by SQL. The geo columns describe
  the venue's connection, not visitors; `latitude`/`longitude`/`postalCode` are deliberately
  absent (IP geolocation resolves to an ISP centroid, and every column here has to survive "why
  do you have this?").
- **Indexes:** `(installation_pk, client_id)` is the join back to `records` — deliberately **not**
  UNIQUE; the repetition is the content. `(received_at)` serves the sweep, which must not lean on
  rowid order (it only approximates arrival order). Nothing else: ad-hoc filters over a
  90-day-bounded table are not worth taxing every insert, and these two already cost two extra
  B-tree writes per record ingested.

## SQLite/D1 traps encoded in this schema

- **`VARCHAR(n)` lengths are not enforced** and there is no date type; every length and format
  limit is a `CHECK` (dates via `GLOB`).
- **D1 caps a GLOB pattern at 50 bytes** (stock SQLite: 50,000). `[0-9]` costs five, so ten
  character classes is the entire budget — and an over-budget pattern fails **at INSERT, not at
  migration time** (`migrations apply` accepts a CHECK that can never be evaluated). `0003`'s date
  pattern is at 42 bytes; any new date/timestamp CHECK will look reasonable and fail. Use
  `substr()` plus several short patterns, as `0004` does. `test/d1-record-store.spec.ts` pins the
  limit.
- **`INTEGER` affinity converts well-formed literals** (`'3320'` → `3320`) but silently keeps
  `'AS3320'` as TEXT, a float as REAL, and an int64 overflow as REAL — all comparing equal to no
  integer. Only `typeof(x) = 'integer'` sees it (hence the `cf_asn` CHECK).
- **100 bound parameters per statement** (per statement within a batch, not per batch) — the
  reason inserts are one statement per record per table inside a single `batch()`, never a
  multi-row `VALUES`.

## Sizing

The free plan is the binding ceiling: **500 MB per database** and **100k rows written per day**
(index writes count against it) — the row-write limit breaks first. Growth of
`record_submissions` is bounded by `MAX_SUBMISSIONS_PER_RECORD` plus the 90-day sweep; a busy
exhibit is thousands of records a day, tens of megabytes a quarter. (`0004`'s header originally
sized this against the paid plan's 10 GB; that arithmetic was twenty times too forgiving and has
been removed rather than corrected by a migration, since the cap that answers it lives in
`src/config.ts` and needed no schema change.)
