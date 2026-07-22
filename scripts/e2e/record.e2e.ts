import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createE2eDb, firstRow, type E2eDb } from './harness.ts';

// Records and submissions cannot be created through the CLI (the Worker does that), so beforeAll seeds
// them with raw SQL: two records for the 'game' installation, submitted across two POSTs — S1 created
// record A; S2 was a batch of two (A resent, B created), which is what gives the log its per-submission
// grain. The erase test seeds and removes its own third record, so the shared fixtures stay intact.
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const S3 = '33333333-3333-4333-8333-333333333333';
const CREATED_AT_A = '2026-07-01T12:00:00+02:00';

describe('export, log, and erase', () => {
  let db: E2eDb;
  let instId = 0;
  let keyId = 0;

  const recordId = (clientId: string) => firstRow(db.rawSql<{ id: number }>(`SELECT id FROM records WHERE client_id = '${clientId}';`)).id;

  beforeAll(() => {
    db = createE2eDb();
    for (const args of [
      ['installation', 'create', '--app', 'game'],
      ['key', 'mint', '--app', 'game', '--kind', 'write', '--label', 'ingest'],
    ]) {
      const r = db.runCli(args);
      if (r.status !== 0) throw new Error(r.stderr);
    }
    instId = firstRow(db.rawSql<{ id: number }>(`SELECT id FROM installations WHERE app_id = 'game';`)).id;
    keyId = firstRow(db.rawSql<{ id: number }>(`SELECT id FROM api_keys WHERE installation_pk = ${instId};`)).id;
    db.rawSql(`
      INSERT INTO records (installation_pk, client_id, created_date, received_date, engine_version, content_version, app_data)
      VALUES (${instId}, '${A}', '2026-07-01', '2026-07-01', '1.0.0', 'v2', '{"choice":"bus"}');
      INSERT INTO records (installation_pk, client_id, created_date, received_date, engine_version, content_version, app_data)
      VALUES (${instId}, '${B}', '2026-07-10', '2026-07-10', '1.0.0', NULL, '[1,2]');
      INSERT INTO record_submissions (submission_id, installation_pk, key_id, client_id, created_at, received_at, client_ip, user_agent, cf_country, cf_as_organization, cf_colo, cf_timezone)
      VALUES ('${S1}', ${instId}, ${keyId}, '${A}', '${CREATED_AT_A}', '2026-07-01T10:00:00.000Z', '203.0.113.7', 'ExhibitEngine/1.0', 'DE', 'Example ISP', 'FRA', 'Europe/Berlin');
      INSERT INTO record_submissions (submission_id, installation_pk, key_id, client_id, created_at, received_at, client_ip, user_agent, cf_country, cf_as_organization, cf_colo, cf_timezone)
      VALUES ('${S2}', ${instId}, ${keyId}, '${A}', '${CREATED_AT_A}', '2026-07-10T07:30:00.000Z', '203.0.113.7', 'ExhibitEngine/1.0', 'DE', 'Example ISP', 'FRA', 'Europe/Berlin');
      INSERT INTO record_submissions (submission_id, installation_pk, key_id, client_id, created_at, received_at, client_ip, user_agent, cf_country, cf_as_organization, cf_colo, cf_timezone)
      VALUES ('${S2}', ${instId}, ${keyId}, '${B}', '2026-07-10T09:15:00+02:00', '2026-07-10T07:30:00.000Z', '203.0.113.7', 'ExhibitEngine/1.0', 'DE', 'Example ISP', 'FRA', 'Europe/Berlin');
    `);
  });

  afterAll(() => {
    db.cleanup();
  });

  it('export records emits NDJSON with single-encoded app_data and no timestamps', () => {
    const r = db.runCli(['export', 'records']);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('Exported 2 record(s).');

    const lines = r.stdout.trim().split('\n');
    expect(lines).toHaveLength(2);
    const rows = lines.map((line) => JSON.parse(line) as Record<string, unknown>);

    const rowA = rows.find((row) => row.client_id === A);
    expect(rowA?.app_data).toEqual({ choice: 'bus' }); // a value, not a JSON string inside JSON
    expect(rowA).toMatchObject({ app_id: 'game', instance_id: 'default', created_date: '2026-07-01', engine_version: '1.0.0' });
    // Dates only on the wire — the exact times live in record_submissions, which export never touches.
    expect(Object.keys(rowA ?? {}).sort()).toEqual([
      'app_data',
      'app_id',
      'client_id',
      'content_version',
      'created_date',
      'engine_version',
      'id',
      'instance_id',
      'received_date',
    ]);

    const rowB = rows.find((row) => row.client_id === B);
    expect(rowB?.app_data).toEqual([1, 2]);
    expect(rowB?.content_version).toBeNull();
  });

  it('export --from/--to bound created_date', () => {
    const later = db.runCli(['export', 'records', '--from', '2026-07-05']);
    expect(later.stderr).toContain('Exported 1 record(s).');
    expect((JSON.parse(later.stdout.trim()) as { client_id: string }).client_id).toBe(B);

    const range = db.runCli(['export', 'records', '--from', '2026-07-01', '--to', '2026-07-05']);
    expect(range.stderr).toContain('Exported 1 record(s).');
    expect((JSON.parse(range.stdout.trim()) as { client_id: string }).client_id).toBe(A);
  });

  it('export --json emits one array instead of NDJSON', () => {
    const r = db.runCli(['export', 'records', '--json']);
    expect(r.status).toBe(0);
    const rows = JSON.parse(r.stdout) as unknown[];
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(2);
  });

  it('log last-seen reports the latest contact with its edge data', () => {
    const r = db.runCli(['log', 'last-seen']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/game\s+default\s+2026-07-10T07:30:00\.000Z\s+203\.0\.113\.7\s+Example ISP\s+FRA/);
  });

  it('log stale-batches finds the multi-record submission by its shared submission_id', () => {
    const r = db.runCli(['log', 'stale-batches', '--min', '1']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`${S2}\\s+\\S+\\s+2\\s`));
    expect(r.stdout).not.toContain(S1); // one row per POST — a single-record submission is not stale
  });

  it('log record-time shows every submission of the record, created_at verbatim', () => {
    const r = db.runCli(['log', 'record-time', '--id', String(recordId(A))]);
    expect(r.status).toBe(0);
    // Two submissions (creating POST + resend), each carrying the offset exactly as the exhibit sent it.
    expect(r.stdout.split(CREATED_AT_A)).toHaveLength(3);
    expect(r.stdout).toContain('2026-07-01T10:00:00.000Z');
    expect(r.stdout).toContain('2026-07-10T07:30:00.000Z');
  });

  it('record erase removes the record and its log rows, leaving every other row intact', () => {
    db.rawSql(`
      INSERT INTO records (installation_pk, client_id, created_date, received_date, engine_version, content_version, app_data)
      VALUES (${instId}, '${C}', '2026-06-15', '2026-06-15', '1.0.0', NULL, 'null');
      INSERT INTO record_submissions (submission_id, installation_pk, key_id, client_id, created_at, received_at)
      VALUES ('${S3}', ${instId}, ${keyId}, '${C}', '2026-06-15T14:00:00+02:00', '2026-06-15T12:00:00.000Z');
    `);

    const r = db.runCli(['record', 'erase', '--id', String(recordId(C))]);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('Erased 1 record and 1 submission-log row(s).');

    const counts = firstRow(
      db.rawSql<{ c_records: number; c_subs: number; records: number; subs: number }>(`
        SELECT
          (SELECT COUNT(*) FROM records WHERE client_id = '${C}') AS c_records,
          (SELECT COUNT(*) FROM record_submissions WHERE client_id = '${C}') AS c_subs,
          (SELECT COUNT(*) FROM records) AS records,
          (SELECT COUNT(*) FROM record_submissions) AS subs;
      `),
    );
    expect(counts).toEqual({ c_records: 0, c_subs: 0, records: 2, subs: 3 });
  });
});
