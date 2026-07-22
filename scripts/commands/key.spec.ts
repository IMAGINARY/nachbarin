import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { key } from './key.ts';
import { runD1Execute } from '../lib/wrangler.ts';
import { confirmTyped } from '../lib/confirm.ts';

// These tests cover what the e2e suite cannot safely reach: the --remote confirmation gate (e2e never
// targets remote) and the argument branches that fail before any SQL runs. The happy paths against a
// real database live in scripts/e2e/key.e2e.ts. Mocking runD1Execute (not queryRows/executeAndCount)
// keeps lib/d1.ts's real parsing in the loop, fed the same JSON shapes wrangler emits.
vi.mock('../lib/wrangler.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/wrangler.ts')>()),
  runD1Execute: vi.fn(),
}));
vi.mock('../lib/confirm.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/confirm.ts')>()),
  confirmTyped: vi.fn(),
}));

const ONE_MATCH = '[{"results":[{"id":3,"kind":"write"}],"success":true}]';
const UPDATED_ONE = '[{"results":[],"success":true},{"results":[{"n":1}],"success":true}]';

const revoke = (args: string[], remote = false) => key.verbs.revoke.run({ args, remote });

beforeEach(() => {
  // restoreAllMocks only restores spies, so the module mocks' call history must be reset here — the
  // call-count assertions below would otherwise see calls from earlier tests.
  vi.resetAllMocks();
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('key revoke', () => {
  it('rejects --id and --label together before any SQL runs', async () => {
    await expect(revoke(['--id', '3', '--label', 'floor-1'])).rejects.toThrow(/not both/);
    expect(runD1Execute).not.toHaveBeenCalled();
  });

  it('requires a selector', async () => {
    await expect(revoke([])).rejects.toThrow(/Provide --id, or --label/);
    expect(runD1Execute).not.toHaveBeenCalled();
  });

  it('on --remote, a declined confirmation aborts before the UPDATE', async () => {
    vi.mocked(runD1Execute).mockReturnValueOnce(ONE_MATCH);
    vi.mocked(confirmTyped).mockResolvedValue(false);
    await expect(revoke(['--id', '3'], true)).rejects.toThrow(/Aborted/);
    expect(runD1Execute).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runD1Execute).mock.calls[0]?.[0].sql).not.toContain('UPDATE');
  });

  it('on --remote, a matching confirmation issues the UPDATE', async () => {
    vi.mocked(runD1Execute).mockReturnValueOnce(ONE_MATCH).mockReturnValueOnce(UPDATED_ONE);
    vi.mocked(confirmTyped).mockResolvedValue(true);
    await revoke(['--id', '3'], true);
    expect(runD1Execute).toHaveBeenCalledTimes(2);
    expect(vi.mocked(runD1Execute).mock.calls[1]?.[0].sql).toContain('UPDATE api_keys SET revoked_at');
  });

  it('never prompts on local — the low-stakes default', async () => {
    vi.mocked(runD1Execute).mockReturnValueOnce(ONE_MATCH).mockReturnValueOnce(UPDATED_ONE);
    await revoke(['--id', '3']);
    expect(confirmTyped).not.toHaveBeenCalled();
  });
});
