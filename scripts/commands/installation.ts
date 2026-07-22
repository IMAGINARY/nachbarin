/**
 * `installation` commands — create, edit, list, and delete the (app_id, instance_id) pairs records belong to.
 *
 * `create` replaces the README's "Registering an installation" recipe and is additive (no confirmation);
 * `edit` renames the pair and/or rewrites the label in place — safe because every reference uses the
 * surrogate id, so keys, records and log rows follow the rename;
 * `list` is the one legitimately global read — a full inventory with per-installation child counts;
 * `delete` is guarded — every child FK is ON DELETE RESTRICT, so it refuses a non-empty installation and
 * only tears one down with an explicit --cascade. Every value spliced into SQL goes through lib/sql.ts
 * (identifiers) or escapeLiteral (the free-form label) — wrangler has no parameter binding.
 */

import { parseArgs } from 'node:util';
import { type CommandContext, type CommandGroup, requireInstallationPair } from '../lib/command.ts';
import { confirmTyped } from '../lib/confirm.ts';
import { executeAndCount, queryRows } from '../lib/d1.ts';
import { assertIdentifier, escapeLiteral } from '../lib/sql.ts';
import { formatTable } from '../lib/table.ts';

/** A row of `installation list` output: the pair, its label/created, and its child-row counts. */
interface InstallationRow {
  id: number;
  app_id: string;
  instance_id: string;
  label: string | null;
  created_at: string;
  records: number;
  active_keys: number;
  revoked_keys: number;
  submissions: number;
}

function runCreate(ctx: CommandContext): void {
  const { values } = parseArgs({
    args: ctx.args,
    options: { app: { type: 'string' }, instance: { type: 'string' }, label: { type: 'string' } },
    allowPositionals: false,
  });

  const { app, instance } = requireInstallationPair(values);
  const labelSql = values.label === undefined ? 'NULL' : escapeLiteral(values.label);

  // Insert-via-SELECT guarded by NOT EXISTS so re-registering a pair is a friendly "already exists" rather
  // than a raw UNIQUE(app_id, instance_id) violation from wrangler. app/instance passed assertIdentifier;
  // only the free-form label needs escaping.
  const sql = `
    INSERT INTO installations (app_id, instance_id, label)
    SELECT '${app}', '${instance}', ${labelSql}
    WHERE NOT EXISTS (SELECT 1 FROM installations WHERE app_id = '${app}' AND instance_id = '${instance}');
  `;
  if (executeAndCount(sql, ctx) === 0) {
    throw new Error(`Installation ${app}/${instance} already exists.`);
  }
  process.stderr.write(`Registered installation ${app}/${instance}.\n`);
}

async function runEdit(ctx: CommandContext): Promise<void> {
  const { values } = parseArgs({
    args: ctx.args,
    options: {
      app: { type: 'string' },
      instance: { type: 'string' },
      'new-app': { type: 'string' },
      'new-instance': { type: 'string' },
      'new-label': { type: 'string' },
    },
    allowPositionals: false,
  });

  const { app, instance } = requireInstallationPair(values);
  const newApp = values['new-app'] ?? app;
  const newInstance = values['new-instance'] ?? instance;
  if (values['new-app'] !== undefined) assertIdentifier(newApp, 'new-app');
  if (values['new-instance'] !== undefined) assertIdentifier(newInstance, 'new-instance');

  const pair = `${app}/${instance}`;
  const newPair = `${newApp}/${newInstance}`;
  const pairChanges = newApp !== app || newInstance !== instance;
  if (!pairChanges && values['new-label'] === undefined) {
    throw new Error('Nothing to change: provide --new-app, --new-instance, and/or --new-label.');
  }

  // Resolve the source id and probe the target pair in one read. Precheck and UPDATE are not one
  // transaction, but UNIQUE (app_id, instance_id) backstops the race — the probe exists for the
  // friendly message, same stance as `create`'s NOT EXISTS guard.
  const [probe] = queryRows<{ source_id: number | null; target_id: number | null }>(
    `
    SELECT
      (SELECT id FROM installations WHERE app_id = '${app}' AND instance_id = '${instance}') AS source_id,
      (SELECT id FROM installations WHERE app_id = '${newApp}' AND instance_id = '${newInstance}') AS target_id;
    `,
    ctx,
  );
  if (probe === undefined || probe.source_id === null) {
    throw new Error(`No installation ${pair} found.`);
  }
  if (pairChanges && probe.target_id !== null) {
    throw new Error(`Installation ${newPair} already exists — renaming ${pair} onto it would collide.`);
  }

  if (pairChanges) {
    process.stderr.write(
      `About to rename ${pair} to ${newPair}. Keys, records and log rows stay attached (references use ` +
        `the surrogate id), and existing records will be reported under the new pair.\n`,
    );
    // Typed confirmation on --remote only when the identity changes (as in `key revoke`); a
    // label-only edit is cosmetic and skips it.
    if (ctx.remote) {
      const ok = await confirmTyped(pair, `Type ${JSON.stringify(pair)} to confirm renaming on --remote: `);
      if (!ok) throw new Error('Aborted: confirmation did not match.');
    }
  }

  const sets: string[] = [];
  if (pairChanges) sets.push(`app_id = '${newApp}'`, `instance_id = '${newInstance}'`);
  if (values['new-label'] !== undefined) {
    // --new-label '' clears the label back to NULL, `create`'s "no label" state.
    sets.push(`label = ${values['new-label'] === '' ? 'NULL' : escapeLiteral(values['new-label'])}`);
  }

  // `source_id` was just resolved from the pair — a surrogate integer, safe to interpolate (as in
  // the cascade delete below).
  const changed = executeAndCount(`UPDATE installations SET ${sets.join(', ')} WHERE id = ${probe.source_id};`, ctx);
  if (changed !== 1) {
    throw new Error(`Expected to update 1 installation, updated ${changed}.`);
  }

  const labelNote =
    values['new-label'] === undefined ? '' : values['new-label'] === '' ? ' (label cleared)' : ` (label: ${values['new-label']})`;
  process.stderr.write(pairChanges ? `Renamed ${pair} to ${newPair}${labelNote}.\n` : `Updated ${pair}${labelNote}.\n`);
}

function runList(ctx: CommandContext): void {
  // No scope flag: the full inventory is the one legitimately global read (an operator listing what exists),
  // unlike GET /v1/records, which a read key may only run against its own installation. Empty options still
  // rejects stray flags.
  parseArgs({ args: ctx.args, options: {}, allowPositionals: false });

  // Correlated counts per installation. `api_keys` is split active/revoked so rotation is visible (as in
  // `key list`); the `record_submissions` count also feeds the `delete` guard's reasoning.
  const sql = `
    SELECT i.id, i.app_id, i.instance_id, i.label, i.created_at,
      (SELECT COUNT(*) FROM records            r WHERE r.installation_pk = i.id)                              AS records,
      (SELECT COUNT(*) FROM api_keys           k WHERE k.installation_pk = i.id AND k.revoked_at IS NULL)     AS active_keys,
      (SELECT COUNT(*) FROM api_keys           k WHERE k.installation_pk = i.id AND k.revoked_at IS NOT NULL) AS revoked_keys,
      (SELECT COUNT(*) FROM record_submissions s WHERE s.installation_pk = i.id)                              AS submissions
    FROM installations i
    ORDER BY i.id;
  `;
  const rows = queryRows<InstallationRow>(sql, ctx);
  if (rows.length === 0) {
    process.stdout.write('No installations.\n');
    return;
  }
  // KEYS is active/revoked, e.g. `2/1`.
  process.stdout.write(
    formatTable(
      ['ID', 'APP', 'INSTANCE', 'LABEL', 'CREATED', 'RECORDS', 'KEYS', 'SUBS'],
      rows.map((r) => [
        String(r.id),
        r.app_id,
        r.instance_id,
        r.label ?? '',
        r.created_at,
        String(r.records),
        `${r.active_keys}/${r.revoked_keys}`,
        String(r.submissions),
      ]),
    ),
  );
}

async function runDelete(ctx: CommandContext): Promise<void> {
  const { values } = parseArgs({
    args: ctx.args,
    options: { app: { type: 'string' }, instance: { type: 'string' }, cascade: { type: 'boolean' } },
    allowPositionals: false,
  });

  const { app, instance } = requireInstallationPair(values);
  const pair = `${app}/${instance}`;

  // Resolve the surrogate id and the three child-row counts in one read. All child FKs are ON DELETE
  // RESTRICT, so a bare delete of a non-empty installation would fail anyway — we count first to refuse
  // (or, with --cascade, to report and tear down in FK order) with a clear message.
  const [found] = queryRows<{ id: number; records: number; keys: number; submissions: number }>(
    `
    SELECT i.id,
      (SELECT COUNT(*) FROM records            r WHERE r.installation_pk = i.id) AS records,
      (SELECT COUNT(*) FROM api_keys           k WHERE k.installation_pk = i.id) AS keys,
      (SELECT COUNT(*) FROM record_submissions s WHERE s.installation_pk = i.id) AS submissions
    FROM installations i
    WHERE i.app_id = '${app}' AND i.instance_id = '${instance}';
    `,
    ctx,
  );
  if (found === undefined) {
    throw new Error(`No installation ${pair} found.`);
  }

  if (!values.cascade) {
    const blockers = found.records + found.keys + found.submissions;
    if (blockers > 0) {
      throw new Error(
        `Refusing to delete ${pair}: ${found.records} records, ${found.keys} keys, ${found.submissions} log rows. ` +
          `Use --cascade to delete it and all of them (only for an installation created by mistake).`,
      );
    }
    // Empty installation: a plain delete, confirmed on --remote only (like `key revoke`).
    process.stderr.write(`About to delete empty installation ${pair}.\n`);
    if (ctx.remote) {
      const ok = await confirmTyped(pair, `Type ${JSON.stringify(pair)} to confirm deleting on --remote: `);
      if (!ok) throw new Error('Aborted: confirmation did not match.');
    }
    executeAndCount(`DELETE FROM installations WHERE app_id = '${app}' AND instance_id = '${instance}';`, ctx);
    process.stderr.write(`Deleted installation ${pair}.\n`);
    return;
  }

  // --cascade destroys record_submissions (the forensic log) and every api_keys row, including
  // deliberately-kept revoked history. Confirm even on --local — it is unrecoverable and spans four tables,
  // stronger than `key revoke`.
  process.stderr.write(
    `About to CASCADE-delete ${pair} and all of its data: ` +
      `${found.records} records, ${found.keys} keys (incl. revoked history), ${found.submissions} log rows.\n`,
  );
  const ok = await confirmTyped(pair, `Type ${JSON.stringify(pair)} to confirm cascade-delete: `);
  if (!ok) throw new Error('Aborted: confirmation did not match.');

  // Children first, installation last, in FK order. Not one transaction (same as the README recipes).
  // `id` is a surrogate integer just resolved from the pair, so it is safe to interpolate.
  executeAndCount(
    `
    DELETE FROM record_submissions WHERE installation_pk = ${found.id};
    DELETE FROM records            WHERE installation_pk = ${found.id};
    DELETE FROM api_keys           WHERE installation_pk = ${found.id};
    DELETE FROM installations      WHERE id = ${found.id};
    `,
    ctx,
  );
  process.stderr.write(
    `Cascade-deleted ${pair}: ${found.records} records, ${found.keys} keys, ${found.submissions} log rows, 1 installation.\n`,
  );
}

export const installation: CommandGroup = {
  description: 'Installations — the (app_id, instance_id) pairs that records belong to.',
  verbs: {
    create: { summary: 'Register a new installation.', run: runCreate },
    edit: { summary: 'Rename the (app, instance) pair and/or change the label.', run: runEdit },
    list: { summary: 'List all installations with record, key, and submission counts.', run: runList },
    delete: {
      summary: 'Delete an installation (refuses unless empty; --cascade forces, for mistakes only).',
      run: runDelete,
    },
  },
};
