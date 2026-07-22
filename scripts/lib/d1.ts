/**
 * Small helpers over `wrangler d1 execute --json` shared by every command module.
 *
 * Kept in lib/ (not inside a single command) because reading rows and reading an affected-row count are
 * the two things every noun-verb does; the SQL differs per command, these do not. Both go through
 * lib/wrangler.ts, which is the only place that spawns wrangler.
 */

import type { CommandContext } from './command.ts';
import { extractJson, runD1Execute } from './wrangler.ts';

/** One element of `wrangler d1 execute --json` output — one per statement. Only the `results` we read. */
export interface D1ExecResult<Row> {
  results: Row[];
}

/** Runs a single read statement and returns its rows. */
export function queryRows<Row>(sql: string, ctx: CommandContext): Row[] {
  const [first] = extractJson<D1ExecResult<Row>[]>(runD1Execute({ sql, remote: ctx.remote, json: true }));
  if (first === undefined) throw new Error('wrangler returned no result set.');
  return first.results;
}

/**
 * Runs a write statement and returns the number of rows it changed, read from SQLite's `changes()` as a
 * trailing statement. Not `meta.changes`: wrangler's `--json` meta omits it on local D1 (only `duration`
 * is present), so `changes()` is the one row count that reads the same on local and remote.
 */
export function executeAndCount(sql: string, ctx: CommandContext): number {
  const payload = extractJson<D1ExecResult<{ n: number }>[]>(
    runD1Execute({ sql: `${sql}\nSELECT changes() AS n;`, remote: ctx.remote, json: true }),
  );
  const n = payload.at(-1)?.results[0]?.n;
  if (typeof n !== 'number') throw new Error('Could not read changes() from wrangler output.');
  return n;
}
