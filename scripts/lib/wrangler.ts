/**
 * Wrapper around `wrangler d1 execute` — the CLI's only path to the database.
 *
 * wrangler has no parameter binding, so callers build SQL with the helpers in ./sql.ts and pass the
 * finished statement here. `--local` is the default; `--remote` must be asked for explicitly, mirroring
 * the repo's deliberate lack of a db:migrate:remote script.
 *
 * Split into pure argv-building and JSON-extraction (unit-tested) plus a thin spawn.
 */

import { spawnSync } from 'node:child_process';

// The positional database name for `wrangler d1 execute`, NOT the Worker binding (which is `DB`). It is
// the `database_name` in wrangler.jsonc.
const DB_NAME = 'nachbarin';

export interface D1ExecuteOptions {
  sql: string;
  /** Target the remote (production) database. Defaults to false — local. */
  remote?: boolean;
  /** Ask wrangler for `--json` output (used by read/query commands). */
  json?: boolean;
}

/**
 * Builds the argv for `wrangler d1 execute ...`. Pure, so the flag wiring is unit-testable without
 * spawning. `--local` is emitted explicitly rather than left implicit, so the target is never ambiguous
 * in `ps` output or a log.
 */
export function buildD1ExecuteArgs({ sql, remote = false, json = false }: D1ExecuteOptions): string[] {
  const args = ['wrangler', 'd1', 'execute', DB_NAME, remote ? '--remote' : '--local'];
  if (json) args.push('--json');
  args.push('--command', sql);
  return args;
}

/**
 * Extracts the JSON payload from wrangler's stdout. wrangler can print an update-check banner (and other
 * chatter) to stdout ahead of the actual JSON, so this slices from the first `[`/`{` to the last `]`/`}`
 * rather than `JSON.parse`-ing raw stdout. Throws if no JSON-looking span is present.
 */
export function extractJson<T = unknown>(stdout: string): T {
  const start = stdout.search(/[[{]/);
  const end = Math.max(stdout.lastIndexOf(']'), stdout.lastIndexOf('}'));
  if (start === -1 || end < start) {
    throw new Error(`No JSON found in wrangler output:\n${stdout}`);
  }
  return JSON.parse(stdout.slice(start, end + 1)) as T;
}

/**
 * Runs `wrangler d1 execute` and returns its stdout. Thin: delegates arg-building to
 * {@link buildD1ExecuteArgs}, and callers that want structured output pass the result through
 * {@link extractJson}. Invoked via `npx` so it uses the repo's pinned wrangler. Throws on a non-zero
 * exit, leaving the caller's error boundary to handle it.
 */
export function runD1Execute(options: D1ExecuteOptions): string {
  const result = spawnSync('npx', buildD1ExecuteArgs(options), { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`wrangler exited with status ${result.status ?? 'null'}:\n${result.stderr}`);
  }
  return result.stdout;
}
