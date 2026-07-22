import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { record } from './record.ts';
import { runD1Execute } from '../lib/wrangler.ts';
import { confirmTyped } from '../lib/confirm.ts';

// The third destructive verb's gating, same pattern as key revoke / installation delete. The real
// two-table erase against a database lives in scripts/e2e/record.e2e.ts. See key.spec.ts for the
// mocking approach.
vi.mock('../lib/wrangler.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/wrangler.ts')>()),
  runD1Execute: vi.fn(),
}));
vi.mock('../lib/confirm.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/confirm.ts')>()),
  confirmTyped: vi.fn(),
}));

const FOUND = '[{"results":[{"record":1,"log_rows":2}],"success":true}]';
const NOT_FOUND = '[{"results":[{"record":0,"log_rows":0}],"success":true}]';
const ERASED = '[{"results":[],"success":true},{"results":[],"success":true},{"results":[{"n":1}],"success":true}]';

const erase = (args: string[], remote = false) => record.verbs.erase.run({ args, remote });

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('record erase', () => {
  it('throws for a missing record, issuing no DELETE', async () => {
    vi.mocked(runD1Execute).mockReturnValueOnce(NOT_FOUND);
    await expect(erase(['--id', '9'])).rejects.toThrow(/No record with id 9/);
    expect(runD1Execute).toHaveBeenCalledTimes(1);
  });

  it('on --remote, a declined confirmation issues no DELETE', async () => {
    vi.mocked(runD1Execute).mockReturnValueOnce(FOUND);
    vi.mocked(confirmTyped).mockResolvedValue(false);
    await expect(erase(['--id', '9'], true)).rejects.toThrow(/Aborted/);
    expect(runD1Execute).toHaveBeenCalledTimes(1);
  });

  it('erases locally without prompting — log rows first, then the record', async () => {
    vi.mocked(runD1Execute).mockReturnValueOnce(FOUND).mockReturnValueOnce(ERASED);
    await erase(['--id', '9']);
    expect(confirmTyped).not.toHaveBeenCalled();
    const sql = vi.mocked(runD1Execute).mock.calls[1]?.[0].sql ?? '';
    expect(sql.indexOf('DELETE FROM record_submissions')).toBeGreaterThanOrEqual(0);
    expect(sql.indexOf('DELETE FROM record_submissions')).toBeLessThan(sql.indexOf('DELETE FROM records'));
  });
});
