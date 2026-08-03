/**
 * The `record` verbs: `stats` reads counts per installation, `erase` deletes one record and its log rows.
 *
 * `record stats` answers "is this venue still producing?" — a lifetime count and a count over a trailing
 * window, side by side. `installation list` already prints the lifetime figure, but with no window a venue
 * that stopped submitting three weeks ago looks exactly like one that submitted this morning.
 *
 * `record erase` exists for a genuine erasure request or a vandalised entry, and replaces the README's
 * "Erasing a record" recipe. Its statement order is load-bearing and is the *opposite* of a cascade delete:
 * the log rows are located *through* the record (a subquery over `records`), so `record_submissions` must go
 * first, while the record row still exists, then the record. Not one transaction — same as the README
 * recipe. The record id is validated to a positive integer, so it is safe to interpolate bare.
 */

import { parseArgs } from 'node:util';
import { type CommandContext, type CommandGroup, requireFlag, requirePositiveInt } from '../lib/command.ts';
import { confirmTyped } from '../lib/confirm.ts';
import { formatCsv } from '../lib/csv.ts';
import { executeAndCount, queryRows } from '../lib/d1.ts';
import { assertDate, assertIdentifier, escapeLiteral } from '../lib/sql.ts';
import { formatTable } from '../lib/table.ts';

/** The trailing window `record stats` reports when --days is not given. */
const DEFAULT_STATS_DAYS = 30;

interface StatsRow {
  app_id: string;
  instance_id: string;
  total: number;
  recent: number;
}

/**
 * The first date of the `days`-long window ending on `today` — both 'YYYY-MM-DD' in UTC, both ends
 * inclusive, so `--days 1` is today alone and `--days 30` reaches back 29 days.
 *
 * `Date.UTC` does the calendar arithmetic: it normalizes a negative or oversized day into the previous
 * month or year, and UTC has no DST, so there is no hour to lose on the way. `today` is a parameter rather
 * than read from the clock, which is what makes this deterministic under test.
 */
export function windowStart(today: string, days: number): string {
  const [year, month, day] = today.split('-').map(Number);
  const start = new Date(Date.UTC(year, month - 1, day - (days - 1)));
  // `--days 1e15` is a valid positive integer but lands outside the representable range, where
  // toISOString() throws a bare "Invalid time value". Name the flag instead.
  if (Number.isNaN(start.getTime())) {
    throw new Error(`Invalid --days: ${days}. The window would start outside the representable date range.`);
  }
  return start.toISOString().slice(0, 10);
}

function runStats(ctx: CommandContext): void {
  const { values } = parseArgs({
    args: ctx.args,
    options: {
      app: { type: 'string' },
      instance: { type: 'string' },
      days: { type: 'string' },
      csv: { type: 'boolean' },
    },
    allowPositionals: false,
  });

  // Deliberately not requireInstallationPair: there the flags *address* one installation and --instance
  // defaults to 'default'. Here they are filters, and an absent --instance means "every instance of this
  // app" — a different question from "the instance named default". --instance alone is refused rather than
  // guessed at, because instance_id is not globally unique: it would silently sum unrelated apps that
  // happen to share an instance name.
  if (values.instance !== undefined && values.app === undefined) {
    throw new Error('--instance narrows --app; provide --app too.');
  }
  const clauses: string[] = [];
  if (values.app !== undefined) {
    assertIdentifier(values.app, 'app_id');
    clauses.push(`i.app_id = ${escapeLiteral(values.app)}`);
  }
  if (values.instance !== undefined) {
    assertIdentifier(values.instance, 'instance_id');
    clauses.push(`i.instance_id = ${escapeLiteral(values.instance)}`);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

  const days = values.days === undefined ? DEFAULT_STATS_DAYS : requirePositiveInt(values.days, 'days');
  // UTC whatever the operator's machine is set to, which is the frame received_date is stored in.
  const today = new Date().toISOString().slice(0, 10);
  const from = windowStart(today, days);
  assertDate(from, 'window start'); // generated, not typed — but nothing reaches SQL unaudited

  // One LEFT JOIN pass rather than `installation list`'s correlated subqueries: both counts come off the
  // same scan. The LEFT JOIN is what keeps a silent installation in the output — for an installation with
  // no records the joined row is all NULL, so COUNT ignores it (0) and the CASE falls to ELSE (0), and the
  // venue reads `0 0` instead of vanishing. That case is the whole point of the command.
  //
  // The window is over received_date — the server's UTC date, when the record landed — and NOT over
  // created_date, which is what `export records --from/--to` filters on. A client draining a queue it could
  // not send for a week should count on the day we actually received it.
  //
  // This reads every `records` row for the matched installations. records_by_installation
  // (installation_pk, id) covers the grouping, and received_date is deliberately unindexed (0003): an index
  // there would tax every insert to speed up an occasional operator command.
  const sql = `
    SELECT i.app_id, i.instance_id,
           COUNT(r.id) AS total,
           SUM(CASE WHEN r.received_date >= ${escapeLiteral(from)} THEN 1 ELSE 0 END) AS recent
    FROM installations i
    LEFT JOIN records r ON r.installation_pk = i.id
    ${where}
    GROUP BY i.id
    ORDER BY i.app_id, i.instance_id;
  `;
  const rows = queryRows<StatsRow>(sql, ctx);

  // The column header names the window's length but not its dates, so stderr carries the exact bounds —
  // where `record stats --csv > stats.csv` leaves them visible rather than in the file.
  process.stderr.write(`Window: ${from}..${today} (${days} day(s), by received_date).\n`);

  const headers = ['APP', 'INSTANCE', 'TOTAL', `LAST_${days}D`];
  const cells = rows.map((r) => [r.app_id, r.instance_id, String(r.total), String(r.recent)]);

  if (values.csv === true) {
    // Header row even with no matches: an empty CSV is still a valid CSV, and a prose line is not.
    const csvHeaders = headers.map((h) => h.toLowerCase());
    process.stdout.write(formatCsv(csvHeaders, cells));
    return;
  }
  if (rows.length === 0) {
    process.stdout.write('No installations match.\n');
    return;
  }
  process.stdout.write(formatTable(headers, cells));
}

async function runErase(ctx: CommandContext): Promise<void> {
  const { values } = parseArgs({ args: ctx.args, options: { id: { type: 'string' } }, allowPositionals: false });
  const id = requirePositiveInt(requireFlag(values.id, 'id'), 'id');

  // Pre-count in one read: whether the record exists, and how many log rows join to it. log_rows may be 0
  // (the 90-day window swept them) — that is not an error, the record is still erased.
  const [found] = queryRows<{ record: number; log_rows: number }>(
    `
    SELECT
      (SELECT COUNT(*) FROM records WHERE id = ${id}) AS record,
      (SELECT COUNT(*) FROM record_submissions
        WHERE (installation_pk, client_id) IN (SELECT installation_pk, client_id FROM records WHERE id = ${id})) AS log_rows;
    `,
    ctx,
  );
  if (found === undefined || found.record === 0) {
    throw new Error(`No record with id ${id}.`);
  }

  process.stderr.write(`About to erase record ${id} and its ${found.log_rows} submission-log row(s).\n`);

  // Typed confirmation only for --remote, like `key revoke` / an empty `installation delete`. Local is the
  // low-stakes default.
  if (ctx.remote) {
    const ok = await confirmTyped(String(id), `Type ${id} to confirm erasing on --remote: `);
    if (!ok) throw new Error('Aborted: confirmation did not match.');
  }

  // Log rows first (found through the record via the subquery), then the record — the README's order.
  // Not one transaction. `changes()` reflects the last statement, i.e. the record delete (1).
  const deleted = executeAndCount(
    `
    DELETE FROM record_submissions
      WHERE (installation_pk, client_id) IN (SELECT installation_pk, client_id FROM records WHERE id = ${id});
    DELETE FROM records WHERE id = ${id};
    `,
    ctx,
  );
  process.stderr.write(`Erased ${deleted} record and ${found.log_rows} submission-log row(s).\n`);
}

export const record: CommandGroup = {
  description: 'Records — counts per installation, and erasure of a stored record with its submission-log rows.',
  verbs: {
    stats: { summary: 'Record counts per installation, lifetime and over a trailing window.', run: runStats },
    erase: { summary: 'Delete a record by id, plus its record_submissions rows.', run: runErase },
  },
};
