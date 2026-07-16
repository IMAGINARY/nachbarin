/**
 * In-memory test doubles.
 *
 * Not a `*.spec.ts` file, so vitest does not collect it; it lives under `test/` so it never ships
 * in the Worker bundle.
 *
 * `FakeRecordStore` implements real dedupe and cursor semantics rather than returning canned
 * values, so the handler tests exercise genuine behaviour while the database is still unbuilt.
 */

import type { Principal, WritePrincipal } from '../src/auth';
import type { Deps, InsertOutcome, KeyStore, ListPage, ListQuery, NewRecord, RecordStore, StoredRecord } from '../src/storage';

export class FakeKeyStore implements KeyStore {
  private readonly keys = new Map<string, Principal>();

  set(key: string, principal: Principal): this {
    this.keys.set(key, principal);
    return this;
  }

  resolve(presentedKey: string): Promise<Principal | null> {
    return Promise.resolve(this.keys.get(presentedKey) ?? null);
  }
}

export class FakeRecordStore implements RecordStore {
  readonly rows: StoredRecord[] = [];
  /** Counts calls so tests can assert that storage was never reached. */
  insertCalls = 0;
  listCalls = 0;
  /** When set, every operation rejects with it. */
  failWith: Error | null = null;

  private nextId = 1;

  insert(principal: WritePrincipal, receivedAt: Date, records: readonly NewRecord[]): Promise<InsertOutcome[]> {
    this.insertCalls++;
    if (this.failWith !== null) return Promise.reject(this.failWith);

    const outcomes = records.map((record) => {
      // Dedupe is scoped to the installation -- the (app_id, instance_id) pair -- and never to
      // instance_id alone: that is `default` for most apps, so two apps at the same instance would
      // collide and the second one's records would be dropped as acknowledged duplicates.
      const exists = this.rows.some(
        (row) =>
          row.app_id === principal.appId &&
          row.instance_id === principal.instanceId &&
          row.client_id === record.clientId,
      );
      if (exists) return 'duplicate' as const;

      this.rows.push({
        id: this.nextId++,
        app_id: principal.appId,
        instance_id: principal.instanceId,
        client_id: record.clientId,
        created_at: record.createdAt,
        received_at: receivedAt.toISOString(),
        engine_version: record.engineVersion,
        content_version: record.contentVersion,
        app_data: JSON.parse(record.appDataJson) as unknown,
      });
      return 'created' as const;
    });

    return Promise.resolve(outcomes);
  }

  list(query: ListQuery): Promise<ListPage> {
    this.listCalls++;
    if (this.failWith !== null) return Promise.reject(this.failWith);

    const matching = this.rows
      .filter((row) => row.id > query.afterId)
      .filter((row) => query.appId === null || row.app_id === query.appId)
      .filter((row) => query.instanceId === null || row.instance_id === query.instanceId)
      .filter((row) => query.engineVersion === null || row.engine_version === query.engineVersion)
      // Mirrors SQL equality: a NULL content_version never matches a filter value.
      .filter((row) => query.contentVersion === null || row.content_version === query.contentVersion)
      .sort((a, b) => a.id - b.id);

    // Fetch limit+1 and report the overflow, exactly as the real adapter should.
    const page = matching.slice(0, query.limit + 1);
    const hasMore = page.length > query.limit;

    return Promise.resolve({ records: hasMore ? page.slice(0, query.limit) : page, hasMore });
  }
}

export const WRITE_A: WritePrincipal = {
  kind: 'write',
  appId: 'app-1',
  instanceId: 'instance-a',
};

/** Same app as A, different instance. */
export const WRITE_B: WritePrincipal = {
  kind: 'write',
  appId: 'app-1',
  instanceId: 'instance-b',
};

/**
 * Same *instance* as A, different app — the other axis of the dedupe scope, and the one that
 * `instance_id`-only dedupe gets wrong. Instances are shared in practice: two apps in the same
 * museum both sit at `instance-a`, and by default both would sit at `default`.
 */
export const WRITE_C: WritePrincipal = {
  kind: 'write',
  appId: 'app-2',
  instanceId: 'instance-a',
};

export const KEY_A = 'key-write-a';
export const KEY_B = 'key-write-b';
export const KEY_C = 'key-write-c';
export const KEY_READ = 'key-read';

export const FIXED_NOW = new Date('2026-07-15T12:00:00.000Z');

export interface TestDeps extends Deps {
  readonly keyStore: FakeKeyStore;
  readonly recordStore: FakeRecordStore;
}

/** Deps pre-wired with three write keys and one read key. */
export function makeDeps(): TestDeps {
  const keyStore = new FakeKeyStore()
    .set(KEY_A, WRITE_A)
    .set(KEY_B, WRITE_B)
    .set(KEY_C, WRITE_C)
    .set(KEY_READ, { kind: 'read' });

  return { keyStore, recordStore: new FakeRecordStore(), now: () => FIXED_NOW };
}

let uuidCounter = 0;

/** Deterministic unique UUIDs — `crypto.randomUUID` would make failures unreproducible. */
export function uuid(): string {
  uuidCounter++;
  return `3f8a0000-0000-4000-8000-${uuidCounter.toString(16).padStart(12, '0')}`;
}

export function validRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    client_id: uuid(),
    created_at: '2026-07-15T14:03:22+02:00',
    engine_version: 'engine-1.4.2',
    app_data: { nodes: [['q1', 3]] },
    ...overrides,
  };
}

/** A valid record with one field removed, for testing that required fields are enforced. */
export function recordWithout(field: string): Record<string, unknown> {
  const record = validRecord();
  delete record[field];
  return record;
}

export function postRequest(body: unknown, key: string | null = KEY_A, init: RequestInit = {}): Request {
  const headers = new Headers({ 'content-type': 'application/json', ...(init.headers as Record<string, string>) });
  if (key !== null) headers.set('authorization', `Bearer ${key}`);

  return new Request('https://example.com/v1/records', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...init,
    headers,
  });
}

export function getRequest(query = '', key: string | null = KEY_READ): Request {
  const headers = new Headers();
  if (key !== null) headers.set('authorization', `Bearer ${key}`);

  return new Request(`https://example.com/v1/records${query}`, { method: 'GET', headers });
}
