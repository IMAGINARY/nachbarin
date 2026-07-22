import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashKey } from '../lib/keygen.ts';
import { createE2eDb, firstRow, type E2eDb } from './harness.ts';

const HEX64 = /[0-9a-f]{64}/;

// All tests share the 'kiosk' installation (created once below) but mint their own keys, so none
// depends on another test's state.
describe('key', () => {
  let db: E2eDb;

  beforeAll(() => {
    db = createE2eDb();
    const created = db.runCli(['installation', 'create', '--app', 'kiosk']);
    if (created.status !== 0) throw new Error(created.stderr);
  });

  afterAll(() => {
    db.cleanup();
  });

  it('mint prints exactly the key to stdout, stores only its hash, and list never shows it', () => {
    const r = db.runCli(['key', 'mint', '--app', 'kiosk', '--kind', 'write', '--label', 'floor-1']);
    expect(r.status).toBe(0);
    // stdout is the key and nothing else, so `key mint ... > key.txt` captures exactly the key.
    expect(r.stdout).toMatch(/^[A-Za-z0-9_-]{43}\n$/);
    expect(r.stderr).toContain('Minted write key for kiosk/default (label: floor-1).');
    expect(r.stdout + r.stderr).not.toMatch(HEX64);

    const stored = firstRow(db.rawSql<{ key_hash: string }>(`SELECT key_hash FROM api_keys WHERE label = 'floor-1';`));
    expect(stored.key_hash).toBe(hashKey(r.stdout.trim()));

    const list = db.runCli(['key', 'list', '--app', 'kiosk']);
    expect(list.status).toBe(0);
    expect(list.stdout).toMatch(/write\s+active\s+\S+\s+floor-1/);
    expect(list.stdout).not.toMatch(HEX64);
    expect(list.stdout).not.toContain(r.stdout.trim());
  });

  it('mint for an unknown installation stores nothing and prints no key', () => {
    const before = firstRow(db.rawSql<{ n: number }>(`SELECT COUNT(*) AS n FROM api_keys;`)).n;
    const r = db.runCli(['key', 'mint', '--app', 'ghost', '--kind', 'read']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('No installation ghost/default found — key not minted.');
    expect(r.stdout).toBe('');
    expect(firstRow(db.rawSql<{ n: number }>(`SELECT COUNT(*) AS n FROM api_keys;`)).n).toBe(before);
  });

  it('revoke --id soft-deletes without prompting on local', () => {
    expect(db.runCli(['key', 'mint', '--app', 'kiosk', '--kind', 'read', '--label', 'by-id']).status).toBe(0);
    const { id } = firstRow(db.rawSql<{ id: number }>(`SELECT id FROM api_keys WHERE label = 'by-id';`));

    const r = db.runCli(['key', 'revoke', '--id', String(id)]);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('Revoked 1 key(s).');

    const { revoked_at } = firstRow(db.rawSql<{ revoked_at: string | null }>(`SELECT revoked_at FROM api_keys WHERE id = ${id};`));
    expect(revoked_at).not.toBeNull();
    // Columns: ID KIND STATE CREATED LABEL.
    expect(db.runCli(['key', 'list', '--app', 'kiosk']).stdout).toMatch(/read\s+revoked \S+\s+\S+\s+by-id/);
  });

  it('revoke --label touches only the matching key', () => {
    expect(db.runCli(['key', 'mint', '--app', 'kiosk', '--kind', 'write', '--label', 'alpha']).status).toBe(0);
    expect(db.runCli(['key', 'mint', '--app', 'kiosk', '--kind', 'write', '--label', 'beta']).status).toBe(0);

    const r = db.runCli(['key', 'revoke', '--label', 'alpha', '--app', 'kiosk']);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('Revoked 1 key(s).');

    const rows = db.rawSql<{ label: string; revoked_at: string | null }>(
      `SELECT label, revoked_at FROM api_keys WHERE label IN ('alpha', 'beta') ORDER BY label;`,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]?.revoked_at).not.toBeNull();
    expect(rows[1]?.revoked_at).toBeNull();
  });
});
