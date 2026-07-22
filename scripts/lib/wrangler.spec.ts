import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { buildD1ExecuteArgs, extractJson, runD1Execute } from './wrangler.ts';

// Only runD1Execute reaches spawnSync; the pure helpers above it are unaffected by the mock.
vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));

describe('buildD1ExecuteArgs', () => {
  it('defaults to --local with no --json', () => {
    expect(buildD1ExecuteArgs({ sql: 'SELECT 1;' })).toEqual([
      'wrangler',
      'd1',
      'execute',
      'nachbarin',
      '--local',
      '--command',
      'SELECT 1;',
    ]);
  });

  it('uses --remote when asked', () => {
    expect(buildD1ExecuteArgs({ sql: 'SELECT 1;', remote: true })).toEqual([
      'wrangler',
      'd1',
      'execute',
      'nachbarin',
      '--remote',
      '--command',
      'SELECT 1;',
    ]);
  });

  it('adds --json before the command', () => {
    expect(buildD1ExecuteArgs({ sql: 'SELECT 1;', json: true })).toEqual([
      'wrangler',
      'd1',
      'execute',
      'nachbarin',
      '--local',
      '--json',
      '--command',
      'SELECT 1;',
    ]);
  });

  it('places --persist-to after the target, before --json', () => {
    expect(buildD1ExecuteArgs({ sql: 'SELECT 1;', json: true, persistTo: '/tmp/e2e' })).toEqual([
      'wrangler',
      'd1',
      'execute',
      'nachbarin',
      '--local',
      '--persist-to',
      '/tmp/e2e',
      '--json',
      '--command',
      'SELECT 1;',
    ]);
  });

  it('drops persistTo with --remote — the flag is local-only', () => {
    expect(buildD1ExecuteArgs({ sql: 'SELECT 1;', remote: true, persistTo: '/tmp/e2e' })).toEqual([
      'wrangler',
      'd1',
      'execute',
      'nachbarin',
      '--remote',
      '--command',
      'SELECT 1;',
    ]);
  });
});

describe('runD1Execute', () => {
  const exited = (over: Partial<SpawnSyncReturns<string>>): SpawnSyncReturns<string> => ({
    status: 0,
    stdout: '',
    stderr: '',
    pid: 1,
    output: [],
    signal: null,
    ...over,
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.mocked(spawnSync).mockReset();
  });

  it('threads NACHBARIN_D1_PERSIST_TO into the spawned argv', () => {
    vi.stubEnv('NACHBARIN_D1_PERSIST_TO', '/tmp/e2e');
    vi.mocked(spawnSync).mockReturnValue(exited({ stdout: 'out' }));
    expect(runD1Execute({ sql: 'SELECT 1;' })).toBe('out');
    expect(spawnSync).toHaveBeenCalledWith(
      'npx',
      ['wrangler', 'd1', 'execute', 'nachbarin', '--local', '--persist-to', '/tmp/e2e', '--command', 'SELECT 1;'],
      { encoding: 'utf8' },
    );
  });

  it('spawns without --persist-to when the env var is unset', () => {
    vi.stubEnv('NACHBARIN_D1_PERSIST_TO', undefined);
    vi.mocked(spawnSync).mockReturnValue(exited({ stdout: 'out' }));
    runD1Execute({ sql: 'SELECT 1;' });
    expect(spawnSync).toHaveBeenCalledWith('npx', ['wrangler', 'd1', 'execute', 'nachbarin', '--local', '--command', 'SELECT 1;'], {
      encoding: 'utf8',
    });
  });

  it('rethrows a spawn error', () => {
    vi.mocked(spawnSync).mockReturnValue(exited({ error: new Error('spawn npx ENOENT'), status: null }));
    expect(() => runD1Execute({ sql: 'SELECT 1;' })).toThrow('spawn npx ENOENT');
  });

  it('throws with stderr when wrangler exits non-zero', () => {
    vi.mocked(spawnSync).mockReturnValue(exited({ status: 1, stderr: 'D1_ERROR: no such table' }));
    expect(() => runD1Execute({ sql: 'SELECT 1;' })).toThrow(/wrangler exited with status 1:\nD1_ERROR/);
  });
});

describe('extractJson', () => {
  it('parses clean JSON output', () => {
    expect(extractJson('[{"results":[],"success":true}]')).toEqual([{ results: [], success: true }]);
  });

  it('ignores an update-check banner printed before the JSON', () => {
    const stdout = [
      '',
      '╭──────────────────────────────────────────╮',
      '│  A new version of wrangler is available.  │',
      '╰──────────────────────────────────────────╯',
      '[{"results":[{"n":1}],"success":true}]',
      '',
    ].join('\n');
    expect(extractJson(stdout)).toEqual([{ results: [{ n: 1 }], success: true }]);
  });

  it('throws when there is no JSON to find', () => {
    expect(() => extractJson('some error text, no json here')).toThrow(/No JSON/);
  });
});
