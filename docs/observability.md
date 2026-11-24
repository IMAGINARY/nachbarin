# Worker logs

What the Worker writes to [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/),
and what it deliberately does not. Read this before adding a field.

**"The log" in this repo means `record_submissions`** — the forensic table read through
`node scripts/cli.ts log …`. This page is about something else: the Worker's own application logs,
viewable in the Cloudflare dashboard under **Workers & Pages → nachbarin → Observability**, or live
with `npx wrangler tail`. Where the two could be confused, this page says _Worker log_ and _submission
log_.

Based on `src/observability.ts`. `observability.enabled` is `true` in `wrangler.jsonc`, with
`head_sampling_rate` left at its default of 1.

## Two rules

**Every call passes exactly one object.** Workers Logs extracts and indexes the fields of a lone
object argument. `console.log('msg', { a: 1 })` stores the pair as an array and indexes nothing, so
`a` becomes unfilterable and the value is findable only by text match. This is why `src/` routes
every call through `src/observability.ts` and why `no-console` is on everywhere else.

**One log event per invocation.** Cloudflare emits its own _invocation log_ alongside ours, carrying
the method, full URL, status, outcome, CPU time and wall time. So our line carries only what that one
cannot, and a failed request stamps its detail onto the same line rather than emitting a second. The
arithmetic is tight on the free plan: 200,000 log events/day against a 100,000 request/day ceiling
means two events per request is exactly the budget, with nothing left over.

## What is never logged

The rule is need-to-know — the same principle `record_submissions` is built on. Two halves:

- **Never the visitor payload.** No `app_data`, no request body, no `client_id`. Nothing from
  `Provenance` except `submission_id` — no IP, user agent, city, ASN, timezone or colo. Those belong
  in `record_submissions`, which no API key can read and which expires at `METADATA_RETENTION_DAYS`.
  A log line has neither property.
- **Nothing Cloudflare already records.** Restating the invocation log spends the event budget to say
  what is on the adjacent row.

Also excluded: the bearer key (`key_id` is the handle instead — the hash is one-way, and the
submission log already uses that number), and validation `message` strings. Three of those interpolate
client-supplied field and query-parameter _names_, so the `error` code is logged and the prose is not,
even though the client is shown both.

**The first half is a principle, not a list of field names**, because the sharpest case does not look
like one. V8 quotes the first ~10 characters of its input in a `JSON.parse` error, verbatim:

```
JSON.parse('canary-visitor-data')
  → Unexpected token 'c', "canary-vis"... is not valid JSON
```

`src/d1-record-store.ts` parses `app_data` uncaught on the read path, so an internal error string is
not automatically free of visitor data — and no rule phrased over variable names would catch it,
because the value never passes through anything called `app_data`. Error text is clamped to 1 KB,
which bounds the damage but cannot prevent it: the leaked characters come first. Logging it anyway is
a deliberate trade — a 500 nobody can diagnose is worse, and these lines live 3–7 days behind the same
credentials as the database itself. The mirror case is `handlers.ts`, which drops the request-body
parse error on purpose; "improving" that to log it would put a slice of the submitted batch into the
Worker log on every malformed request.

## Events

`event` is the primary filter dimension. Three values, and the union in `src/observability.ts` is
closed, so this list is checkable.

### `event: "request"` — one per HTTP request

| Field                                         | When                       | Meaning                                                                                                                                                                                                                                      |
| --------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `method`, `status`                            | always                     | Duplicated from the invocation log on purpose: Workers Logs cannot join the two, so a line that omits them is unfilterable on its own.                                                                                                       |
| `error`                                       | status ≥ 400               | The machine-readable code from the response body. The genuinely new bit — `status: 400` does not say which of `invalid_json` / `invalid_request` / `invalid_field` / `batch_too_large`.                                                      |
| `app_id`, `instance_id`, `key_id`, `key_kind` | after the key resolves     | Absent on a 401, 404 or 405, which never got that far.                                                                                                                                                                                       |
| `submission_id`                               | POST that stored something | Joins this line to its `record_submissions` rows. **Absent when the batch stored nothing** — an empty or wholly rejected batch mints no submission id, so filtering on this field filters out exactly the batches from a misbehaving client. |
| `created`, `duplicate`, `rejected`            | POST                       | Reported even when zero: the handler ran, so "none" is a measurement. Without these a 200 says nothing, since a batch from a wholly broken client is also a 200.                                                                             |
| `rejections`                                  | POST, if any               | Counts by code, e.g. `{"invalid_field": 3}`. Overlaps `rejected` on purpose — the scalar is what you notice, the histogram is what tells you which client is broken and how. Omitted when nothing was rejected.                              |
| `returned`, `has_more`                        | GET                        | Whether a reader is keeping up.                                                                                                                                                                                                              |
| `truncated`                                   | GET                        | Whether the response byte budget shortened the page. Recorded nowhere else: a truncated page is deliberately indistinguishable from any other short page on the wire.                                                                        |
| `error_name`, `error_message`, `stack`        | 5xx / 503                  | Clamped to 1 KB each. `stack` overlaps the other two — V8 starts a stack with `name: message` — and is kept because it is the only one that says _where_.                                                                                    |

A CORS preflight is a request too and gets its own line: `method: "OPTIONS"`, `status: 204`, with no
key fields. Browsers cache a preflight for up to two hours (`Access-Control-Max-Age: 7200`), so
there are at most a few of these per kiosk per day.

Emitted at `error` level for 5xx and `info` for everything else. A 4xx is the protocol working; a 5xx
is ours to answer for, and a 503 counts because it means storage failed even though the client should
retry. Anything finer is a query over the indexed `status`.

### `event: "retention_sweep"` — one per cron firing

`cron`, `scheduled_time`, and `deleted` on success; `error_name` / `error_message` / `stack` on
failure, at `error` level, after which the sweep rethrows. Both cases carry the same `event`, so one
filter returns the runs and the failures together — otherwise a failure would show only as an
unexplained `outcome: "exception"` on the invocation log.

`scheduled_time` is the controller's, not the wall clock, and is what says whether a run was on time.

### `event: "unmappable_key_row"` — an `api_keys` row whose `kind` is neither `read` nor `write`

Unreachable while the schema's CHECK holds. Carries `key_id` and `kind`; the holder of that key sees
an ordinary 401 forever, so `key_id` is what makes the row findable.

## What these logs are not

**Not a metric source.** Retention is 3 days on the free plan, 7 on paid, and `head_sampling_rate` is
1 today but can be lowered — counts built on log lines would silently become a sample. Counts come
from the database: `node scripts/cli.ts record stats` and the `log` subcommands.

**Not the retention audit.** The sweep's window is 90 days; log retention is 3. "Has the sweep been
running?" is therefore unanswerable from logs, and the `retention_sweep` line is a convenience rather
than evidence. The audit is a query, and the answer must never be older than
`METADATA_RETENTION_DAYS`:

```sh
npx wrangler d1 execute nachbarin --remote \
  --command "SELECT min(received_at) AS oldest, count(*) AS rows FROM record_submissions"
```

**Not the only thing stored.** Cloudflare's invocation logs are left at their defaults and capture
request metadata and headers of their own accord. Set `observability.logs.invocation_logs` to `false`
in `wrangler.jsonc` to stop that; note it would also stop recording the platform-level failures our
code never sees, such as an exceeded CPU limit.
