/**
 * `export records` — the cross-installation full-corpus read.
 *
 * There is deliberately no key that spans installations (a token that did would be a standing credential
 * reading every venue's data for as long as it exists), so a full export is an operator SQL query, never an
 * API capability. This replaces the README's "Exporting across installations" recipe. Output is
 * machine-consumed and goes to stdout (NDJSON by default, one record per line; `--json` for a single
 * array); the human-facing count goes to stderr so stdout stays pure. Not destructive — no confirmation.
 */

import { parseArgs } from 'node:util';
import { type CommandContext, type CommandGroup } from '../lib/command.ts';
import { queryRows } from '../lib/d1.ts';
import { assertDate, escapeLiteral } from '../lib/sql.ts';

/** One exported record. `app_data` is JSON *text* as stored; serializeExport parses it back to a value. */
interface ExportRow {
  id: number;
  app_id: string;
  instance_id: string;
  client_id: string;
  created_date: string;
  received_date: string;
  engine_version: string;
  content_version: string | null;
  app_data: string;
}

/**
 * Serializes export rows for stdout. Each row's `app_data` is parsed from its stored JSON text back into a
 * real JSON value, so the output is single-encoded rather than a JSON string inside JSON. `JSON.parse` is
 * safe: `records` carries `CHECK (json_valid(app_data))`, so every stored payload parses. NDJSON (default)
 * emits one compact object per line; `{ ndjson: false }` emits one pretty array. Pure, so it is unit-tested.
 */
export function serializeExport(rows: ExportRow[], opts: { ndjson: boolean }): string {
  const parsed = rows.map((r) => ({ ...r, app_data: JSON.parse(r.app_data) as unknown }));
  if (opts.ndjson) {
    return parsed.map((r) => JSON.stringify(r)).join('\n');
  }
  return JSON.stringify(parsed, null, 2);
}

function runRecords(ctx: CommandContext): void {
  const { values } = parseArgs({
    args: ctx.args,
    options: { from: { type: 'string' }, to: { type: 'string' }, json: { type: 'boolean' } },
    allowPositionals: false,
  });

  // Optional date bounds on created_date. Two clauses ANDed together give the README's BETWEEN behaviour;
  // either alone is an open-ended range; neither is the full corpus. assertDate keeps a stray quote out of
  // the interpolated WHERE (it is format-only, not calendar-validated — an impossible date just matches nothing).
  const clauses: string[] = [];
  if (values.from !== undefined) {
    assertDate(values.from, 'from');
    clauses.push(`r.created_date >= ${escapeLiteral(values.from)}`);
  }
  if (values.to !== undefined) {
    assertDate(values.to, 'to');
    clauses.push(`r.created_date <= ${escapeLiteral(values.to)}`);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

  const sql = `
    SELECT r.id, i.app_id, i.instance_id, r.client_id, r.created_date, r.received_date,
           r.engine_version, r.content_version, r.app_data
    FROM records r
    JOIN installations i ON i.id = r.installation_pk
    ${where}
    ORDER BY r.id;
  `;
  const rows = queryRows<ExportRow>(sql, ctx);

  const body = serializeExport(rows, { ndjson: values.json !== true });
  if (body.length > 0) process.stdout.write(`${body}\n`);
  process.stderr.write(`Exported ${rows.length} record(s).\n`);
}

export const exportRecords: CommandGroup = {
  description: 'Export — cross-installation record export (operator-only).',
  verbs: {
    records: { summary: 'Export records across installations by date range (JSON).', run: runRecords },
  },
};
