import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createE2eDb, firstRow, type E2eDb } from './harness.ts';

// Each test works on its own installation (created inside the test), so no test depends on another's
// state — there is no rollback between tests, only the file-level throwaway database.
describe('installation', () => {
  let db: E2eDb;

  beforeAll(() => {
    db = createE2eDb();
  });

  afterAll(() => {
    db.cleanup();
  });

  /** Seeds one record and one submission-log row for an installation that already holds one key. */
  function seedChildren(app: string, instance: string, clientId: string, submissionId: string): void {
    const inst = firstRow(
      db.rawSql<{ id: number }>(`SELECT id FROM installations WHERE app_id = '${app}' AND instance_id = '${instance}';`),
    );
    const key = firstRow(db.rawSql<{ id: number }>(`SELECT id FROM api_keys WHERE installation_pk = ${inst.id};`));
    db.rawSql(`
      INSERT INTO records (installation_pk, client_id, created_date, received_date, engine_version, content_version, app_data)
      VALUES (${inst.id}, '${clientId}', '2026-07-01', '2026-07-01', '1.0.0', NULL, '{"choice":"bus"}');
      INSERT INTO record_submissions (submission_id, installation_pk, key_id, client_id, created_at, received_at, client_ip, user_agent)
      VALUES ('${submissionId}', ${inst.id}, ${key.id}, '${clientId}', '2026-07-01T12:00:00+02:00', '2026-07-01T10:00:00.000Z', '203.0.113.7', 'ExhibitEngine/1.0');
    `);
  }

  it('create registers the pair, defaulting the instance', () => {
    const r = db.runCli(['installation', 'create', '--app', 'museum-a', '--label', 'Museum A']);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('Registered installation museum-a/default.');
    const row = firstRow(
      db.rawSql<{ instance_id: string; label: string }>(`SELECT instance_id, label FROM installations WHERE app_id = 'museum-a';`),
    );
    expect(row).toEqual({ instance_id: 'default', label: 'Museum A' });
  });

  it('re-creating an existing pair fails with a friendly message and stores nothing', () => {
    expect(db.runCli(['installation', 'create', '--app', 'museum-dup']).status).toBe(0);
    const again = db.runCli(['installation', 'create', '--app', 'museum-dup']);
    expect(again.status).toBe(1);
    expect(again.stderr).toContain('Installation museum-dup/default already exists.');
    const { n } = firstRow(db.rawSql<{ n: number }>(`SELECT COUNT(*) AS n FROM installations WHERE app_id = 'museum-dup';`));
    expect(n).toBe(1);
  });

  it('list shows per-installation record, key, and submission counts', () => {
    expect(db.runCli(['installation', 'create', '--app', 'museum-b', '--instance', 'main']).status).toBe(0);
    expect(db.runCli(['key', 'mint', '--app', 'museum-b', '--instance', 'main', '--kind', 'write']).status).toBe(0);
    seedChildren('museum-b', 'main', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111');

    const r = db.runCli(['installation', 'list']);
    expect(r.status).toBe(0);
    // Columns: ID APP INSTANCE LABEL CREATED RECORDS KEYS SUBS — KEYS is active/revoked.
    expect(r.stdout).toMatch(/museum-b\s+main\s+\S+\s+1\s+1\/0\s+1\s*$/m);
  });

  it('delete refuses a non-empty installation, and --cascade needs the typed pair', () => {
    expect(db.runCli(['installation', 'create', '--app', 'museum-del', '--instance', 'main']).status).toBe(0);
    expect(db.runCli(['key', 'mint', '--app', 'museum-del', '--instance', 'main', '--kind', 'write']).status).toBe(0);
    seedChildren('museum-del', 'main', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '22222222-2222-4222-8222-222222222222');
    const counts = () =>
      firstRow(
        db.rawSql<{ installations: number; keys: number; records: number; submissions: number }>(`
          SELECT
            (SELECT COUNT(*) FROM installations      WHERE app_id = 'museum-del') AS installations,
            (SELECT COUNT(*) FROM api_keys           k JOIN installations i ON i.id = k.installation_pk WHERE i.app_id = 'museum-del') AS keys,
            (SELECT COUNT(*) FROM records            r JOIN installations i ON i.id = r.installation_pk WHERE i.app_id = 'museum-del') AS records,
            (SELECT COUNT(*) FROM record_submissions s JOIN installations i ON i.id = s.installation_pk WHERE i.app_id = 'museum-del') AS submissions;
        `),
      );

    const refused = db.runCli(['installation', 'delete', '--app', 'museum-del', '--instance', 'main']);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('Refusing to delete museum-del/main: 1 records, 1 keys, 1 log rows.');
    expect(counts()).toEqual({ installations: 1, keys: 1, records: 1, submissions: 1 });

    const declined = db.runCli(['installation', 'delete', '--app', 'museum-del', '--instance', 'main', '--cascade'], { stdin: 'wrong\n' });
    expect(declined.status).toBe(1);
    expect(declined.stderr).toContain('Aborted: confirmation did not match.');
    expect(counts()).toEqual({ installations: 1, keys: 1, records: 1, submissions: 1 });

    const confirmed = db.runCli(['installation', 'delete', '--app', 'museum-del', '--instance', 'main', '--cascade'], {
      stdin: 'museum-del/main\n',
    });
    expect(confirmed.status).toBe(0);
    expect(confirmed.stderr).toContain('Cascade-deleted museum-del/main: 1 records, 1 keys, 1 log rows, 1 installation.');
    expect(counts()).toEqual({ installations: 0, keys: 0, records: 0, submissions: 0 });
  });

  it('delete removes an empty installation locally without prompting', () => {
    expect(db.runCli(['installation', 'create', '--app', 'museum-empty']).status).toBe(0);
    const r = db.runCli(['installation', 'delete', '--app', 'museum-empty']);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('Deleted installation museum-empty/default.');
    const { n } = firstRow(db.rawSql<{ n: number }>(`SELECT COUNT(*) AS n FROM installations WHERE app_id = 'museum-empty';`));
    expect(n).toBe(0);
  });
});
