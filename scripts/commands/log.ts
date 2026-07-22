/**
 * `log` commands — operator-only diagnostics over `record_submissions`.
 *
 * The submission log has no HTTP endpoint; these verbs are the only structured way to read it, and they
 * replace the README's "Reading the submission log" recipes. Every verb only *renders* what it reads — it
 * never shape-checks or "cleans up" the verbatim edge data, because a value that looks wrong in a forensic
 * table is the point of the table (CLAUDE.md). The only values spliced into SQL are operator-supplied and
 * go through lib/sql.ts (identifiers), escapeLiteral (labels), or requirePositiveInt (ids / counts).
 */

import { parseArgs } from 'node:util';
import { type CommandContext, type CommandGroup, requireFlag, requireInstallationPair, requirePositiveInt } from '../lib/command.ts';
import { queryRows } from '../lib/d1.ts';
import { escapeLiteral } from '../lib/sql.ts';
import { formatTable } from '../lib/table.ts';

/** Renders a nullable text cell: SQL NULL comes back as `null` from wrangler's --json output. */
function cell(value: string | null): string {
  return value ?? '';
}

function runLastSeen(ctx: CommandContext): void {
  parseArgs({ args: ctx.args, options: {}, allowPositionals: false });

  // Global inventory — last contact per installation, with the connection it came in on. Relies on
  // SQLite's single-MAX bare-column rule: with exactly one MAX aggregate, the bare columns
  // (client_ip, cf_as_organization, cf_colo) take their values from the last-seen row. Preserve as-is.
  const sql = `
    SELECT i.app_id, i.instance_id, MAX(s.received_at) AS last_seen,
           s.client_ip, s.cf_as_organization, s.cf_colo
    FROM record_submissions s
    JOIN installations i ON i.id = s.installation_pk
    GROUP BY s.installation_pk
    ORDER BY last_seen;
  `;
  const rows = queryRows<{
    app_id: string;
    instance_id: string;
    last_seen: string;
    client_ip: string | null;
    cf_as_organization: string | null;
    cf_colo: string | null;
  }>(sql, ctx);
  if (rows.length === 0) {
    process.stdout.write('No submissions logged.\n');
    return;
  }
  process.stdout.write(
    formatTable(
      ['APP', 'INSTANCE', 'LAST_SEEN', 'IP', 'ISP', 'COLO'],
      rows.map((r) => [r.app_id, r.instance_id, r.last_seen, cell(r.client_ip), cell(r.cf_as_organization), cell(r.cf_colo)]),
    ),
  );
}

function runFirstRecord(ctx: CommandContext): void {
  const { values } = parseArgs({
    args: ctx.args,
    options: { app: { type: 'string' }, instance: { type: 'string' } },
    allowPositionals: false,
  });

  const { app, instance } = requireInstallationPair(values);

  // Scoped by the full (app_id, instance_id) pair, not the README's instance_id-only filter — instance_id
  // is not unique (it defaults to 'default'), so filtering on it alone would blur two apps at one venue.
  const sql = `
    SELECT s.received_at, s.created_at, s.client_ip, s.user_agent
    FROM record_submissions s
    JOIN installations i ON i.id = s.installation_pk
    WHERE i.app_id = '${app}' AND i.instance_id = '${instance}'
    ORDER BY s.received_at
    LIMIT 1;
  `;
  const rows = queryRows<{ received_at: string; created_at: string; client_ip: string | null; user_agent: string | null }>(sql, ctx);
  if (rows.length === 0) {
    process.stdout.write(`No submissions for ${app}/${instance}.\n`);
    return;
  }
  process.stdout.write(
    formatTable(
      ['RECEIVED', 'CREATED', 'IP', 'USER_AGENT'],
      rows.map((r) => [r.received_at, r.created_at, cell(r.client_ip), cell(r.user_agent)]),
    ),
  );
}

function runKeyActivity(ctx: CommandContext): void {
  const { values } = parseArgs({
    args: ctx.args,
    options: { id: { type: 'string' }, app: { type: 'string' }, instance: { type: 'string' }, label: { type: 'string' } },
    allowPositionals: false,
  });

  if (values.id !== undefined && values.label !== undefined) {
    throw new Error('Provide either --id or --label, not both.');
  }

  // Select the key the same two ways `key revoke` does: by surrogate id, or by label within an installation.
  let predicate: string;
  let describe: string;
  if (values.id !== undefined) {
    const id = requirePositiveInt(values.id, 'id');
    predicate = `k.id = ${id}`;
    describe = `key id ${id}`;
  } else if (values.label !== undefined) {
    const { app, instance } = requireInstallationPair(values);
    predicate =
      `k.installation_pk = (SELECT id FROM installations WHERE app_id = '${app}' AND instance_id = '${instance}') ` +
      `AND k.label = ${escapeLiteral(values.label)}`;
    describe = `label ${JSON.stringify(values.label)} in ${app}/${instance}`;
  } else {
    throw new Error('Provide --id, or --label with --app, to select the key.');
  }

  // What a key has been doing, grouped by (client_ip, user_agent): two IPs where you expected one, or a
  // user_agent that is not the engine, is worth a look before revoking it.
  const sql = `
    SELECT k.label, s.client_ip, s.cf_country, s.cf_as_organization, s.user_agent,
           COUNT(*) AS records, MIN(s.received_at) AS first_seen, MAX(s.received_at) AS last_seen
    FROM record_submissions s
    JOIN api_keys k ON k.id = s.key_id
    WHERE ${predicate}
    GROUP BY s.client_ip, s.user_agent
    ORDER BY COUNT(*) DESC;
  `;
  const rows = queryRows<{
    label: string | null;
    client_ip: string | null;
    cf_country: string | null;
    cf_as_organization: string | null;
    user_agent: string | null;
    records: number;
    first_seen: string;
    last_seen: string;
  }>(sql, ctx);
  if (rows.length === 0) {
    process.stdout.write(`No submissions for ${describe}.\n`);
    return;
  }
  process.stdout.write(
    formatTable(
      ['LABEL', 'IP', 'COUNTRY', 'ISP', 'USER_AGENT', 'RECORDS', 'FIRST_SEEN', 'LAST_SEEN'],
      rows.map((r) => [
        cell(r.label),
        cell(r.client_ip),
        cell(r.cf_country),
        cell(r.cf_as_organization),
        cell(r.user_agent),
        String(r.records),
        r.first_seen,
        r.last_seen,
      ]),
    ),
  );
}

function runStaleBatches(ctx: CommandContext): void {
  const { values } = parseArgs({ args: ctx.args, options: { min: { type: 'string' } }, allowPositionals: false });

  // Threshold parameterized as --min (the README hardcodes 10); default 10.
  const min = values.min === undefined ? 10 : requirePositiveInt(values.min, 'min');

  // Batches where more than `min` records arrived — a stuck queue resending a large batch of which nothing
  // is new. Cross-check a submission_id against records.received_date: many log rows, no matching records,
  // means every one came back `duplicate`.
  const sql = `
    SELECT s.submission_id, s.received_at, COUNT(*) AS records, s.client_ip
    FROM record_submissions s
    GROUP BY s.submission_id
    HAVING COUNT(*) > ${min}
    ORDER BY s.received_at DESC
    LIMIT 50;
  `;
  const rows = queryRows<{ submission_id: string; received_at: string; records: number; client_ip: string | null }>(sql, ctx);
  if (rows.length === 0) {
    process.stdout.write(`No batches with more than ${min} records.\n`);
    return;
  }
  process.stdout.write(
    formatTable(
      ['SUBMISSION_ID', 'RECEIVED', 'RECORDS', 'IP'],
      rows.map((r) => [r.submission_id, r.received_at, String(r.records), cell(r.client_ip)]),
    ),
  );
}

function runRecordTime(ctx: CommandContext): void {
  const { values } = parseArgs({ args: ctx.args, options: { id: { type: 'string' } }, allowPositionals: false });
  const id = requirePositiveInt(requireFlag(values.id, 'id'), 'id');

  // Exact submission time(s) for one record — the summary says "time(s)", so this drops the README's
  // LIMIT 1: the earliest row is the creating submission, any later ones are resends, and seeing all of
  // them is the point here. created_at comes back exactly as the exhibit sent it; compare its offset
  // against cf_timezone to check whether the exhibit's clock is telling the truth.
  const sql = `
    SELECT s.created_at, s.received_at, s.client_ip, s.cf_timezone
    FROM record_submissions s
    JOIN records r ON r.installation_pk = s.installation_pk AND r.client_id = s.client_id
    WHERE r.id = ${id}
    ORDER BY s.received_at;
  `;
  const rows = queryRows<{ created_at: string; received_at: string; client_ip: string | null; cf_timezone: string | null }>(sql, ctx);
  if (rows.length === 0) {
    process.stdout.write(`No submissions for record ${id} (it may not exist, or its log rows aged out past the 90-day window).\n`);
    return;
  }
  process.stdout.write(
    formatTable(
      ['CREATED_AT', 'RECEIVED_AT', 'IP', 'TIMEZONE'],
      rows.map((r) => [r.created_at, r.received_at, cell(r.client_ip), cell(r.cf_timezone)]),
    ),
  );
}

export const log: CommandGroup = {
  description: 'Submission log — operator-only diagnostics over record_submissions.',
  verbs: {
    'last-seen': { summary: 'Last contact per installation (why a venue went quiet).', run: runLastSeen },
    'first-record': { summary: 'First submission from an installation.', run: runFirstRecord },
    'key-activity': { summary: 'What a given key has been doing.', run: runKeyActivity },
    'stale-batches': { summary: 'Submissions with an unusually high record count (stuck queues).', run: runStaleBatches },
    'record-time': { summary: 'Exact submission time(s) for one record id.', run: runRecordTime },
  },
};
