import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { record, windowStart } from './record.ts';
import { runD1Execute } from '../lib/wrangler.ts';
import { confirmTyped } from '../lib/confirm.ts';

// The third destructive verb's gating, same pattern as key revoke / installation delete. The real
// two-table erase against a database lives in scripts/e2e/record.e2e.ts. See key.spec.ts for the
// mocking approach. `stats` is here for the same reason: the argument branches that fail before any SQL,
// the shape of the SQL it builds, and the stdout/stderr split — its happy path against a real database
// lives in scripts/e2e/stats.e2e.ts.
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
const ONE_STAT = '[{"results":[{"app_id":"game","instance_id":"default","total":5,"recent":2}],"success":true}]';
const NO_STATS = '[{"results":[],"success":true}]';

const erase = (args: string[], remote = false) => record.verbs.erase.run({ args, remote });
// runStats is synchronous, but Handler is `Promise<void> | void` — awaiting through this wrapper turns a
// synchronous throw into a rejection too, so the assertions below hold either way.
const stats = async (args: string[], remote = false): Promise<void> => {
  await record.verbs.stats.run({ args, remote });
};

let out: string[];
let err: string[];
const lastSql = (): string => vi.mocked(runD1Execute).mock.calls.at(-1)?.[0].sql ?? '';
const utcToday = (): string => new Date().toISOString().slice(0, 10);

beforeEach(() => {
  vi.resetAllMocks();
  out = [];
  err = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    err.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('windowStart', () => {
  it('is inclusive of both ends — one day is today alone', () => {
    expect(windowStart('2026-08-03', 1)).toBe('2026-08-03');
  });

  it('reaches back days - 1, so the default window spans 30 dates', () => {
    expect(windowStart('2026-08-03', 30)).toBe('2026-07-05');
  });

  it('rolls back over a month boundary, leap year included', () => {
    expect(windowStart('2026-03-01', 2)).toBe('2026-02-28');
    expect(windowStart('2024-03-01', 2)).toBe('2024-02-29');
  });

  it('rolls back over a year boundary', () => {
    expect(windowStart('2026-01-01', 2)).toBe('2025-12-31');
  });

  it('names the flag when the window would start outside the representable range', () => {
    expect(() => windowStart('2026-08-03', 1e15)).toThrow(/Invalid --days.*representable/);
  });
});

describe('record stats', () => {
  it('rejects --instance without --app before any SQL runs', async () => {
    await expect(stats(['--instance', 'lyon'])).rejects.toThrow(/--instance narrows --app/);
    expect(runD1Execute).not.toHaveBeenCalled();
  });

  it('rejects a non-positive or non-numeric --days before any SQL runs', async () => {
    await expect(stats(['--days', '0'])).rejects.toThrow(/Invalid --days/);
    await expect(stats(['--days', 'abc'])).rejects.toThrow(/Invalid --days/);
    expect(runD1Execute).not.toHaveBeenCalled();
  });

  it('counts every installation when no filter is given, keeping the silent ones', async () => {
    vi.mocked(runD1Execute).mockReturnValueOnce(ONE_STAT);
    await stats([]);
    expect(lastSql()).not.toContain('WHERE');
    expect(lastSql()).toContain('LEFT JOIN records r ON r.installation_pk = i.id');
  });

  it('narrows to an app, and to one instance of it', async () => {
    vi.mocked(runD1Execute).mockReturnValueOnce(ONE_STAT);
    await stats(['--app', 'game', '--instance', 'lyon']);
    expect(lastSql()).toContain("i.app_id = 'game'");
    expect(lastSql()).toContain("i.instance_id = 'lyon'");
  });

  it('windows on received_date, 30 days by default', async () => {
    const today = utcToday();
    vi.mocked(runD1Execute).mockReturnValueOnce(ONE_STAT);
    await stats([]);
    expect(lastSql()).toContain(`r.received_date >= '${windowStart(today, 30)}'`);
  });

  it('honours --days in both the cutoff and the column name', async () => {
    const today = utcToday();
    vi.mocked(runD1Execute).mockReturnValueOnce(ONE_STAT);
    await stats(['--days', '7']);
    expect(lastSql()).toContain(`r.received_date >= '${windowStart(today, 7)}'`);
    expect(out.join('')).toContain('LAST_7D');
  });

  it('puts the exact window on stderr, leaving stdout to the data alone', async () => {
    vi.mocked(runD1Execute).mockReturnValueOnce(ONE_STAT);
    await stats(['--csv']);
    expect(err.join('')).toMatch(/^Window: \d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2} \(30 day\(s\), by received_date\)\.\n$/);
    expect(out.join('')).toBe('app,instance,total,last_30d\ngame,default,5,2\n');
  });

  it('renders an aligned table by default', async () => {
    vi.mocked(runD1Execute).mockReturnValueOnce(ONE_STAT);
    await stats([]);
    expect(out.join('')).toMatch(/^APP\s+INSTANCE\s+TOTAL\s+LAST_30D\n/);
    expect(out.join('')).toMatch(/game\s+default\s+5\s+2/);
  });

  it('emits the header row and nothing else when --csv matches no installation', async () => {
    vi.mocked(runD1Execute).mockReturnValueOnce(NO_STATS);
    await stats(['--csv', '--app', 'nobody']);
    expect(out.join('')).toBe('app,instance,total,last_30d\n');
  });

  it('says so in prose when the table matches no installation', async () => {
    vi.mocked(runD1Execute).mockReturnValueOnce(NO_STATS);
    await stats(['--app', 'nobody']);
    expect(out.join('')).toBe('No installations match.\n');
  });
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
