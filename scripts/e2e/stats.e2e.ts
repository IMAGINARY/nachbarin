import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createE2eDb, firstRow, type E2eDb } from './harness.ts';

// `record stats` end to end, against a real migrated database. The window is relative to *today*, so the
// seed dates are computed here rather than hardcoded — a fixed date would put every record outside the
// window a month after this file was written. The arithmetic is deliberately millisecond-based, an
// independent implementation of the Date.UTC calendar arithmetic in windowStart, so the assertions are
// not a restatement of the code under test.
const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

const clientId = (n: number): string => `0000000${n}-0000-4000-8000-00000000000${n}`;

describe('record stats', () => {
  let db: E2eDb;

  const pk = (app: string, instance: string): number =>
    firstRow(db.rawSql<{ id: number }>(`SELECT id FROM installations WHERE app_id = '${app}' AND instance_id = '${instance}';`)).id;

  function seedRecord(installationPk: number, n: number, createdDate: string, receivedDate: string): void {
    db.rawSql(`
      INSERT INTO records (installation_pk, client_id, created_date, received_date, engine_version, content_version, app_data)
      VALUES (${installationPk}, '${clientId(n)}', '${createdDate}', '${receivedDate}', '1.0.0', NULL, '{"choice":"bus"}');
    `);
  }

  beforeAll(() => {
    db = createE2eDb();
    for (const args of [
      ['installation', 'create', '--app', 'stats-a'],
      ['installation', 'create', '--app', 'stats-a', '--instance', 'tour'],
      ['installation', 'create', '--app', 'stats-b'],
    ]) {
      const r = db.runCli(args);
      if (r.status !== 0) throw new Error(r.stderr);
    }

    // stats-a/default: 4 records, 3 of them received inside a 30-day window, 2 inside a 7-day one.
    const a = pk('stats-a', 'default');
    seedRecord(a, 1, daysAgo(0), daysAgo(0));
    seedRecord(a, 2, daysAgo(20), daysAgo(20));
    seedRecord(a, 3, daysAgo(60), daysAgo(60));
    // Created two months ago but received today — a client draining a queue it could not send. It counts
    // in the window, which is what makes received_date (not created_date) the column being windowed.
    seedRecord(a, 4, daysAgo(60), daysAgo(0));

    // stats-a/tour: one record, long outside the window. stats-b/default: none at all.
    seedRecord(pk('stats-a', 'tour'), 5, daysAgo(40), daysAgo(40));
  });

  afterAll(() => {
    db.cleanup();
  });

  it('counts every installation, keeping the one that has never submitted', () => {
    const r = db.runCli(['record', 'stats']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/APP\s+INSTANCE\s+TOTAL\s+LAST_30D/);
    expect(r.stdout).toMatch(/stats-a\s+default\s+4\s+3/);
    expect(r.stdout).toMatch(/stats-a\s+tour\s+1\s+0/);
    expect(r.stdout).toMatch(/stats-b\s+default\s+0\s+0/);
  });

  it('puts the exact window on stderr and nothing but the table on stdout', () => {
    const r = db.runCli(['record', 'stats']);
    expect(r.stderr).toMatch(/^Window: \d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2} \(30 day\(s\), by received_date\)\.\n$/);
    expect(r.stdout).not.toContain('Window:');
  });

  it('narrows the window with --days, renaming the column', () => {
    const r = db.runCli(['record', 'stats', '--days', '7']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/APP\s+INSTANCE\s+TOTAL\s+LAST_7D/);
    expect(r.stdout).toMatch(/stats-a\s+default\s+4\s+2/);
    expect(r.stderr).toContain('(7 day(s), by received_date)');
  });

  it('filters to one app, and to one instance of it', () => {
    const app = db.runCli(['record', 'stats', '--app', 'stats-a']);
    expect(app.status).toBe(0);
    expect(app.stdout).toContain('stats-a');
    expect(app.stdout).not.toContain('stats-b');

    const one = db.runCli(['record', 'stats', '--app', 'stats-a', '--instance', 'tour']);
    expect(one.status).toBe(0);
    expect(one.stdout).toMatch(/stats-a\s+tour\s+1\s+0/);
    expect(one.stdout).not.toContain('default');
  });

  it('writes CSV to stdout, ordered by app then instance', () => {
    const r = db.runCli(['record', 'stats', '--csv']);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(['app,instance,total,last_30d', 'stats-a,default,4,3', 'stats-a,tour,1,0', 'stats-b,default,0,0', ''].join('\n'));
  });

  it('emits a CSV header alone when nothing matches, but prose in table form', () => {
    const csv = db.runCli(['record', 'stats', '--csv', '--app', 'stats-nobody']);
    expect(csv.status).toBe(0);
    expect(csv.stdout).toBe('app,instance,total,last_30d\n');

    const table = db.runCli(['record', 'stats', '--app', 'stats-nobody']);
    expect(table.status).toBe(0);
    expect(table.stdout).toBe('No installations match.\n');
  });

  it('refuses --instance without --app, since instance_id is not globally unique', () => {
    const r = db.runCli(['record', 'stats', '--instance', 'tour']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--instance narrows --app');
    expect(r.stdout).toBe('');
  });

  it('refuses a --days that is not a positive integer', () => {
    const r = db.runCli(['record', 'stats', '--days', '0']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Invalid --days');
    expect(r.stdout).toBe('');
  });
});
