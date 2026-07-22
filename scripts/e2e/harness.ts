/**
 * E2E harness: a throwaway, fully migrated local D1 per spec file, plus helpers to drive the real CLI
 * against it.
 *
 * Isolation is a temp `--persist-to` directory — never `.wrangler/state`, so the suite cannot touch
 * (or be confused by) the dev database, and the destructive commands under test have nothing to reach.
 * The directory is threaded to the spawned CLI via NACHBARIN_D1_PERSIST_TO (see lib/wrangler.ts).
 *
 * There is no per-test rollback here — that machinery exists only inside the Workers test pool — so
 * spec files keep their tests independent by using distinct installations per test, or by seeding what
 * they need explicitly with rawSql.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { D1ExecResult } from '../lib/d1.ts';
import { buildD1ExecuteArgs, extractJson } from '../lib/wrangler.ts';

// The CLI's inner `npx wrangler` resolves wrangler.jsonc from its cwd, so every spawn pins the repo root.
const REPO_ROOT = join(import.meta.dirname, '..', '..');

export interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs `node scripts/cli.ts <args>` and captures the outcome. `input` defaults to '' so stdin is at EOF
 * immediately — an unexpected confirmation prompt fails fast instead of hanging the suite; a test that
 * expects a prompt pipes the typed line via `stdin`.
 */
export function runCli(args: string[], opts: { stdin?: string; env?: Record<string, string> } = {}): CliResult {
  const result = spawnSync(process.execPath, ['scripts/cli.ts', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    input: opts.stdin ?? '',
    env: { ...process.env, ...opts.env },
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

export interface E2eDb {
  /** The temp `--persist-to` directory holding this database. */
  dir: string;
  /** Runs the CLI against this database. */
  runCli(args: string[], opts?: { stdin?: string }): CliResult;
  /** Runs SQL directly (seeding, DB-state assertions), returning the first statement's rows. */
  rawSql<Row>(sql: string): Row[];
  /** Removes the temp directory. Call from afterAll. */
  cleanup(): void;
}

/** Unwraps a single-row rawSql result, throwing instead of returning undefined. */
export function firstRow<Row>(rows: Row[]): Row {
  const [row] = rows;
  if (row === undefined) throw new Error('Expected at least one row.');
  return row;
}

/** Creates a fresh temp directory and applies `migrations/` to it. One per spec file, in beforeAll. */
export function createE2eDb(): E2eDb {
  const dir = mkdtempSync(join(tmpdir(), 'nachbarin-e2e-'));
  const env = { NACHBARIN_D1_PERSIST_TO: dir, WRANGLER_SEND_METRICS: 'false' };

  // Non-interactive stdin, so wrangler skips its own apply confirmation.
  const apply = spawnSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'nachbarin', '--local', '--persist-to', dir], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  if (apply.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`wrangler d1 migrations apply failed:\n${apply.stderr}\n${apply.stdout}`);
  }

  return {
    dir,
    runCli: (args, opts = {}) => runCli(args, { ...opts, env }),
    rawSql<Row>(sql: string): Row[] {
      const result = spawnSync('npx', buildD1ExecuteArgs({ sql, json: true, persistTo: dir }), {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: { ...process.env, ...env },
      });
      if (result.status !== 0) throw new Error(`wrangler d1 execute failed:\n${result.stderr}`);
      const [first] = extractJson<D1ExecResult<Row>[]>(result.stdout);
      return first?.results ?? [];
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
