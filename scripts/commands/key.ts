/**
 * `key` commands — mint, list, and revoke installation-scoped API keys.
 *
 * These replace the hand-pasted SQL in the README's "Minting a key" / "Revoking a key" recipes. `mint`
 * generates the key in-process (so it never touches shell history), stores only its sha256 hash, and
 * prints the key once to stdout; `list` shows revocation state but never the hash; `revoke` soft-deletes
 * by label or id. Every value spliced into SQL goes through lib/sql.ts (identifiers) or escapeLiteral
 * (free-form text) — wrangler has no parameter binding.
 */

import { parseArgs } from 'node:util';
import type { CommandContext, CommandGroup } from '../lib/command.ts';
import { confirmTyped } from '../lib/confirm.ts';
import { assertIdentifier, escapeLiteral } from '../lib/sql.ts';
import { extractJson, runD1Execute } from '../lib/wrangler.ts';
import { generateKey, hashKey } from '../lib/keygen.ts';

/** One element of `wrangler d1 execute --json` output — one per statement. Only the `results` we read. */
interface D1ExecResult<Row> {
  results: Row[];
}

/** A row of `key list` output. Deliberately excludes `key_hash` — a hash is not a key and is never shown. */
interface KeyRow {
  id: number;
  kind: string;
  label: string | null;
  created_at: string;
  revoked_at: string | null;
}

/** Runs a single read statement and returns its rows. */
function queryRows<Row>(sql: string, ctx: CommandContext): Row[] {
  const [first] = extractJson<D1ExecResult<Row>[]>(runD1Execute({ sql, remote: ctx.remote, json: true }));
  if (first === undefined) throw new Error('wrangler returned no result set.');
  return first.results;
}

/**
 * Runs a write statement and returns the number of rows it changed, read from SQLite's `changes()` as a
 * trailing statement. Not `meta.changes`: wrangler's `--json` meta omits it on local D1 (only `duration`
 * is present), so `changes()` is the one row count that reads the same on local and remote.
 */
function executeAndCount(sql: string, ctx: CommandContext): number {
  const payload = extractJson<D1ExecResult<{ n: number }>[]>(
    runD1Execute({ sql: `${sql}\nSELECT changes() AS n;`, remote: ctx.remote, json: true }),
  );
  const n = payload.at(-1)?.results[0]?.n;
  if (typeof n !== 'number') throw new Error('Could not read changes() from wrangler output.');
  return n;
}

function requireFlag(value: string | undefined, name: string): string {
  if (value === undefined) throw new Error(`Missing required --${name}.`);
  return value;
}

function runMint(ctx: CommandContext): void {
  const { values } = parseArgs({
    args: ctx.args,
    options: {
      app: { type: 'string' },
      instance: { type: 'string' },
      kind: { type: 'string' },
      label: { type: 'string' },
    },
    allowPositionals: false,
  });

  const app = requireFlag(values.app, 'app');
  const instance = values.instance ?? 'default';
  const kind = requireFlag(values.kind, 'kind');
  assertIdentifier(app, 'app_id');
  assertIdentifier(instance, 'instance_id');
  if (kind !== 'read' && kind !== 'write') {
    throw new Error(`Invalid --kind: ${JSON.stringify(kind)}. Must be 'read' or 'write'.`);
  }

  const key = generateKey();
  const hash = hashKey(key);
  const labelSql = values.label === undefined ? 'NULL' : escapeLiteral(values.label);

  // Insert-via-SELECT, so the installation is named the way the operator thinks of it and never looked up
  // by surrogate id. If the pair does not exist, zero rows are inserted — no key stored, so nothing is printed.
  // `hash` is 64-hex and `kind` is already validated to read/write, so both are safe to interpolate; app and
  // instance passed assertIdentifier; only the free-form label needs escaping.
  const sql = `
    INSERT INTO api_keys (key_hash, kind, installation_pk, label)
    SELECT '${hash}', '${kind}', id, ${labelSql}
    FROM installations
    WHERE app_id = '${app}' AND instance_id = '${instance}';
  `;
  if (executeAndCount(sql, ctx) === 0) {
    throw new Error(`No installation ${app}/${instance} found — key not minted. Register the installation first.`);
  }

  // The key is printed once to stdout and nowhere else, so `key mint ... > key.txt` captures exactly the key.
  // Everything human-facing goes to stderr; the hash is never printed. The key is unrecoverable after this.
  const labelNote = values.label === undefined ? '' : ` (label: ${values.label})`;
  process.stderr.write(
    `Minted ${kind} key for ${app}/${instance}${labelNote}.\n` +
      `Only its sha256 is stored — this key cannot be recovered. Hand it over once, via a secure channel.\n`,
  );
  process.stdout.write(`${key}\n`);
}

function runList(ctx: CommandContext): void {
  const { values } = parseArgs({
    args: ctx.args,
    options: { app: { type: 'string' }, instance: { type: 'string' } },
    allowPositionals: false,
  });

  const app = requireFlag(values.app, 'app');
  const instance = values.instance ?? 'default';
  assertIdentifier(app, 'app_id');
  assertIdentifier(instance, 'instance_id');

  const sql = `
    SELECT k.id, k.kind, k.label, k.created_at, k.revoked_at
    FROM api_keys k JOIN installations i ON i.id = k.installation_pk
    WHERE i.app_id = '${app}' AND i.instance_id = '${instance}'
    ORDER BY k.id;
  `;
  const rows = queryRows<KeyRow>(sql, ctx);
  if (rows.length === 0) {
    process.stdout.write(`No keys for ${app}/${instance}.\n`);
    return;
  }
  process.stdout.write(formatKeyTable(rows));
}

/** Aligned plain-text table. `STATE` surfaces revocation (`active` / `revoked <ts>`) so rotation is visible. */
function formatKeyTable(rows: KeyRow[]): string {
  const header = ['ID', 'KIND', 'STATE', 'CREATED', 'LABEL'];
  const body = rows.map((r) => [
    String(r.id),
    r.kind,
    r.revoked_at === null ? 'active' : `revoked ${r.revoked_at}`,
    r.created_at,
    r.label ?? '',
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((row) => row[i].length)));
  const line = (cols: string[]): string =>
    cols
      .map((c, i) => c.padEnd(widths[i]))
      .join('  ')
      .trimEnd();
  return `${[line(header), ...body.map(line)].join('\n')}\n`;
}

async function runRevoke(ctx: CommandContext): Promise<void> {
  const { values } = parseArgs({
    args: ctx.args,
    options: {
      id: { type: 'string' },
      app: { type: 'string' },
      instance: { type: 'string' },
      label: { type: 'string' },
    },
    allowPositionals: false,
  });

  if (values.id !== undefined && values.label !== undefined) {
    throw new Error('Provide either --id or --label, not both.');
  }

  // Both revoke paths share this predicate: the pre-check SELECT, the confirmation target, and the UPDATE
  // all use it, so what is shown to the operator is exactly what is revoked.
  let predicate: string;
  let confirmTarget: string;
  let describe: string;

  if (values.id !== undefined) {
    const id = Number(values.id);
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error(`Invalid --id: ${JSON.stringify(values.id)}. Must be a positive integer.`);
    }
    predicate = `id = ${id} AND revoked_at IS NULL`;
    confirmTarget = String(id);
    describe = `key id ${id}`;
  } else if (values.label !== undefined) {
    const app = requireFlag(values.app, 'app');
    const instance = values.instance ?? 'default';
    assertIdentifier(app, 'app_id');
    assertIdentifier(instance, 'instance_id');
    predicate =
      `installation_pk = (SELECT id FROM installations WHERE app_id = '${app}' AND instance_id = '${instance}') ` +
      `AND label = ${escapeLiteral(values.label)} AND revoked_at IS NULL`;
    confirmTarget = values.label;
    describe = `label ${JSON.stringify(values.label)} in ${app}/${instance}`;
  } else {
    throw new Error('Provide --id, or --label with --app, to select the key to revoke.');
  }

  const matches = queryRows<{ id: number; kind: string }>(`SELECT id, kind FROM api_keys WHERE ${predicate} ORDER BY id;`, ctx);
  if (matches.length === 0) {
    throw new Error(`No active key matching ${describe}.`);
  }
  process.stderr.write(
    `About to revoke ${matches.length} key(s) matching ${describe}: ${matches.map((m) => `#${m.id} (${m.kind})`).join(', ')}.\n`,
  );

  // Typed confirmation only for --remote: local is the default, low-stakes target, mirroring the deliberate
  // absence of a db:migrate:remote script.
  if (ctx.remote) {
    const ok = await confirmTyped(confirmTarget, `Type ${JSON.stringify(confirmTarget)} to confirm revoking on --remote: `);
    if (!ok) throw new Error('Aborted: confirmation did not match.');
  }

  // Soft delete — the row (and its hash) stays, so the hash can never be re-issued and the history is kept.
  const revoked = executeAndCount(`UPDATE api_keys SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ${predicate};`, ctx);
  process.stderr.write(`Revoked ${revoked} key(s).\n`);
}

export const key: CommandGroup = {
  description: 'API keys — installation-scoped read/write credentials.',
  verbs: {
    mint: { summary: 'Generate a key, store its hash, and print the key once.', run: runMint },
    list: { summary: 'List keys for an installation, including revocation state.', run: runList },
    revoke: { summary: 'Revoke a key by label or id (soft-delete via revoked_at).', run: runRevoke },
  },
};
