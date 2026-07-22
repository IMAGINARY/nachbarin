/**
 * `record erase` — delete one record and its submission-log rows, for a genuine erasure request or a
 * vandalised entry.
 *
 * This replaces the README's "Erasing a record" recipe. The statement order is load-bearing and is the
 * *opposite* of a cascade delete: the log rows are located *through* the record (a subquery over `records`),
 * so `record_submissions` must go first, while the record row still exists, then the record. Not one
 * transaction — same as the README recipe. The record id is validated to a positive integer, so it is safe
 * to interpolate bare.
 */

import { parseArgs } from 'node:util';
import { type CommandContext, type CommandGroup, requireFlag, requirePositiveInt } from '../lib/command.ts';
import { confirmTyped } from '../lib/confirm.ts';
import { executeAndCount, queryRows } from '../lib/d1.ts';

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
  description: 'Records — erasure of a stored record and its submission-log rows.',
  verbs: {
    erase: { summary: 'Delete a record by id, plus its record_submissions rows.', run: runErase },
  },
};
