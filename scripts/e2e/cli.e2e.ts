import { describe, expect, it } from 'vitest';
import { runCli } from './harness.ts';

// Dispatcher-level behaviour: both paths return before any command handler runs, so no database is
// needed — these use the bare runCli, not createE2eDb.
describe('cli dispatch', () => {
  it('fails an unknown command with exit code 1 and help on stderr', () => {
    const r = runCli(['frobnicate', 'now']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Unknown command: frobnicate');
    expect(r.stderr).toContain('Usage: node scripts/cli.ts');
    expect(r.stdout).toBe('');
  });

  it('lists every noun and verb under --help', () => {
    const r = runCli(['--help']);
    expect(r.status).toBe(0);
    for (const command of [
      'installation create',
      'installation edit',
      'installation list',
      'installation delete',
      'key mint',
      'key list',
      'key revoke',
      'log last-seen',
      'log first-record',
      'log key-activity',
      'log stale-batches',
      'log record-time',
      'record erase',
      'export records',
    ]) {
      expect(r.stdout).toContain(command);
    }
  });
});
