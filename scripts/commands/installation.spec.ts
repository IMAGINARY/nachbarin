import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installation } from './installation.ts';
import { runD1Execute } from '../lib/wrangler.ts';
import { confirmTyped } from '../lib/confirm.ts';

// Covers delete's guard rails — the branches that must stop before any DELETE reaches the database —
// plus the one gate e2e cannot reach (--remote). The destructive happy paths against a real database
// live in scripts/e2e/installation.e2e.ts. See key.spec.ts for the mocking approach.
vi.mock('../lib/wrangler.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/wrangler.ts')>()),
  runD1Execute: vi.fn(),
}));
vi.mock('../lib/confirm.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/confirm.ts')>()),
  confirmTyped: vi.fn(),
}));

const FOUND_NONEMPTY = '[{"results":[{"id":5,"records":2,"keys":1,"submissions":4}],"success":true}]';
const FOUND_EMPTY = '[{"results":[{"id":5,"records":0,"keys":0,"submissions":0}],"success":true}]';
const CASCADE_DONE =
  '[{"results":[],"success":true},{"results":[],"success":true},{"results":[],"success":true},{"results":[],"success":true},{"results":[{"n":1}],"success":true}]';

const del = (args: string[], remote = false) => installation.verbs.delete.run({ args, remote });

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('installation delete', () => {
  it('refuses a non-empty installation without --cascade, issuing no DELETE', async () => {
    vi.mocked(runD1Execute).mockReturnValueOnce(FOUND_NONEMPTY);
    await expect(del(['--app', 'a'])).rejects.toThrow(/Refusing to delete a\/default: 2 records, 1 keys, 4 log rows/);
    expect(runD1Execute).toHaveBeenCalledTimes(1);
  });

  it('--cascade prompts even locally, and a declined confirmation issues no DELETE', async () => {
    vi.mocked(runD1Execute).mockReturnValueOnce(FOUND_NONEMPTY);
    vi.mocked(confirmTyped).mockResolvedValue(false);
    await expect(del(['--app', 'a', '--cascade'])).rejects.toThrow(/Aborted/);
    expect(confirmTyped).toHaveBeenCalledWith('a/default', expect.any(String));
    expect(runD1Execute).toHaveBeenCalledTimes(1);
  });

  it('an accepted cascade deletes the children before the installation, in FK order', async () => {
    vi.mocked(runD1Execute).mockReturnValueOnce(FOUND_NONEMPTY).mockReturnValueOnce(CASCADE_DONE);
    vi.mocked(confirmTyped).mockResolvedValue(true);
    await del(['--app', 'a', '--cascade']);
    const sql = vi.mocked(runD1Execute).mock.calls[1]?.[0].sql ?? '';
    const order = ['DELETE FROM record_submissions', 'DELETE FROM records', 'DELETE FROM api_keys', 'DELETE FROM installations'].map(
      (stmt) => sql.indexOf(stmt),
    );
    expect(Math.min(...order)).toBeGreaterThanOrEqual(0);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('on --remote, even an empty delete needs a matching confirmation', async () => {
    vi.mocked(runD1Execute).mockReturnValueOnce(FOUND_EMPTY);
    vi.mocked(confirmTyped).mockResolvedValue(false);
    await expect(del(['--app', 'a'], true)).rejects.toThrow(/Aborted/);
    expect(runD1Execute).toHaveBeenCalledTimes(1);
  });
});
