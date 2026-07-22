import { beforeEach, describe, expect, it, vi } from 'vitest';
import { executeAndCount, queryRows } from './d1.ts';
import { runD1Execute } from './wrangler.ts';

// Mock only the spawn; the real extractJson runs, so these tests see the same parsing the CLI does.
vi.mock('./wrangler.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./wrangler.ts')>()),
  runD1Execute: vi.fn(),
}));

const LOCAL = { args: [], remote: false };

beforeEach(() => {
  vi.resetAllMocks();
});

describe('queryRows', () => {
  it('returns the first result set and asks wrangler for --json', () => {
    vi.mocked(runD1Execute).mockReturnValueOnce('[{"results":[{"id":1},{"id":2}],"success":true}]');
    expect(queryRows('SELECT id FROM installations;', LOCAL)).toEqual([{ id: 1 }, { id: 2 }]);
    expect(runD1Execute).toHaveBeenCalledWith({ sql: 'SELECT id FROM installations;', remote: false, json: true });
  });

  it('throws when wrangler returns no result set at all', () => {
    vi.mocked(runD1Execute).mockReturnValueOnce('[]');
    expect(() => queryRows('SELECT 1;', LOCAL)).toThrow(/no result set/);
  });
});

describe('executeAndCount', () => {
  it('appends SELECT changes() and reads the count from the last statement', () => {
    vi.mocked(runD1Execute).mockReturnValueOnce('[{"results":[],"success":true},{"results":[{"n":3}],"success":true}]');
    expect(executeAndCount('DELETE FROM records WHERE id = 7;', LOCAL)).toBe(3);
    expect(runD1Execute).toHaveBeenCalledWith({
      sql: 'DELETE FROM records WHERE id = 7;\nSELECT changes() AS n;',
      remote: false,
      json: true,
    });
  });

  it('throws when changes() is missing from the output', () => {
    vi.mocked(runD1Execute).mockReturnValueOnce('[{"results":[],"success":true}]');
    expect(() => executeAndCount('DELETE FROM records WHERE id = 7;', LOCAL)).toThrow(/Could not read changes\(\)/);
  });
});
