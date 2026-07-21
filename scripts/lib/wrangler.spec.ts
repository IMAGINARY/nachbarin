import { describe, expect, it } from 'vitest';
import { buildD1ExecuteArgs, extractJson } from './wrangler.ts';

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
