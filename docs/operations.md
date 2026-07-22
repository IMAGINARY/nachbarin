# Operations — raw SQL

The operator CLI (`node scripts/cli.ts`, see README "Operations") runs parameterized versions of the
queries below. Reach for the raw SQL here only when you need a shape the CLI does not expose — a
different projection, an extra filter, a join, or `json_extract` over `app_data`. Every query runs
through `wrangler d1 execute`:

```sh
npx wrangler d1 execute nachbarin --local  --command "…"   # try it against the dev database first
npx wrangler d1 execute nachbarin --remote --command "…"   # production
```

`--local` is the safe default to draft against; `--remote` hits production. wrangler has no parameter
binding, so every value is pasted straight into the SQL — mind quotes, and keep `app_id`/`instance_id`
to the `[a-zA-Z0-9._-]` charset (a stray space or quote produces an identifier that matches nothing,
invisibly). Every column referenced below is documented in [database.md](database.md); the
`record_submissions` rows are verbatim forensic data — read them, do not "correct" them.

## Reading the submission log

The log has no HTTP endpoint. Each query has a CLI equivalent under `log`; the SQL is here for
adapting the `WHERE`, the grouping, or the columns.

**Exact submission time(s) for one record** — CLI: `log record-time --id 184002`.

```sql
SELECT s.created_at, s.received_at, s.client_ip, s.cf_timezone
FROM record_submissions s
JOIN records r ON r.installation_pk = s.installation_pk AND r.client_id = s.client_id
WHERE r.id = 184002
ORDER BY s.received_at;
```

The earliest row is the submission that created the record; any later ones are resends. `created_at`
comes back exactly as the exhibit sent it, offset included — compare its offset against `cf_timezone`
(resolved from the IP, independent of what the exhibit claims) to check the exhibit's clock. Add
`LIMIT 1` to see only the creating submission.

**Last contact per installation** — CLI: `log last-seen`.

```sql
SELECT i.app_id, i.instance_id, MAX(s.received_at) AS last_seen,
       s.client_ip, s.cf_as_organization, s.cf_colo
FROM record_submissions s
JOIN installations i ON i.id = s.installation_pk
GROUP BY s.installation_pk
ORDER BY last_seen;
```

An installation missing from the result has sent nothing in 90 days. A `client_ip` or
`cf_as_organization` that changed is a venue that changed connection. (This relies on SQLite's
single-`MAX` bare-column rule: with exactly one aggregate, the bare columns take their values from the
`MAX` row.)

**First submission from an installation** — CLI: `log first-record --app … --instance …`.

```sql
SELECT s.received_at, s.created_at, s.client_ip, s.user_agent
FROM record_submissions s
JOIN installations i ON i.id = s.installation_pk
WHERE i.app_id = 'future-mobility-simulator' AND i.instance_id = 'museum-x'
ORDER BY s.received_at
LIMIT 1;
```

Scope by the full `(app_id, instance_id)` pair, not `instance_id` alone — `instance_id` defaults to
`default` and is not unique, so filtering on it blurs two apps at one venue.

**Batches that stored nothing (a stuck queue)** — CLI: `log stale-batches --min 10`.

```sql
SELECT s.submission_id, s.received_at, COUNT(*) AS records, s.client_ip
FROM record_submissions s
GROUP BY s.submission_id
HAVING COUNT(*) > 10
ORDER BY s.received_at DESC
LIMIT 50;
```

A large batch whose records were all `duplicate` means the exhibit is uploading and storing nothing.
To confirm, check whether a suspect `submission_id`'s `client_id`s still resolve to records:

```sql
SELECT s.client_id,
       (SELECT COUNT(*) FROM records r
        WHERE r.installation_pk = s.installation_pk AND r.client_id = s.client_id) AS record_exists
FROM record_submissions s
WHERE s.submission_id = '00000000-0000-0000-0000-000000000000';
```

**What a key has been doing** — CLI: `log key-activity --id … | --label … --app …`.

```sql
SELECT k.label, s.client_ip, s.cf_country, s.cf_as_organization, s.user_agent,
       COUNT(*) AS records, MIN(s.received_at) AS first_seen, MAX(s.received_at) AS last_seen
FROM record_submissions s
JOIN api_keys k ON k.id = s.key_id
WHERE k.installation_pk = (SELECT id FROM installations
                           WHERE app_id = 'future-mobility-simulator' AND instance_id = 'museum-x')
  AND k.label = 'Station 1, north entrance'
GROUP BY s.client_ip, s.user_agent
ORDER BY COUNT(*) DESC;
```

Two IPs where you expected one, an unexpected country, or a `user_agent` that is not the engine are
each worth a look. Select the key by `k.id = <n>` instead when a label is ambiguous. `key_id` records
which key wrote each row, so this survives the key's revocation.

## Exporting across installations

CLI: `export records --from … --to … [--json]`. The raw query is the place to change the projection,
add a join, or reach into `app_data`:

```sql
SELECT i.app_id, i.instance_id, r.created_date, r.engine_version,
       json_extract(r.app_data, '$.nodes') AS nodes
FROM records r
JOIN installations i ON i.id = r.installation_pk
WHERE r.created_date BETWEEN '2026-07-01' AND '2026-07-31'
ORDER BY r.id;
```

`app_data` is JSON in a text column, so SQLite's JSON functions work on it directly —
`json_extract(r.app_data, '$.nodes')` and friends. A `CHECK (json_valid(app_data))` on the table means
an export can never die partway through on a row that will not parse. Add `--json` to the wrangler
command for machine-readable output.
