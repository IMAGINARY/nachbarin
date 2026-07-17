/**
 * In-memory test doubles.
 *
 * Not a `*.spec.ts` file, so vitest does not collect it; it lives under `test/` so it never ships
 * in the Worker bundle.
 *
 * `FakeRecordStore` implements real dedupe and cursor semantics rather than returning canned
 * values, so the handler tests exercise genuine behaviour without a database.
 */

import type { Principal, ReadPrincipal, WritePrincipal } from '../src/auth';
import type { Provenance } from '../src/provenance';
import type { Deps, InsertOutcome, KeyStore, ListPage, ListQuery, NewRecord, RecordStore, StoredRecord } from '../src/storage';
import { localDateOf } from '../src/validation';

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

/**
 * One `record_submissions` row, as the fake records it. Camel-cased rather than snake_cased: this is
 * not a wire shape, unlike {@link StoredRecord} — nothing ever reads this table over HTTP.
 */
export interface SubmissionRow extends Provenance {
  readonly appId: string;
  readonly instanceId: string;
  readonly keyId: number;
  readonly clientId: string;
  /** Verbatim, offset preserved — the whole reason the table exists. */
  readonly createdAt: string;
  /** Full precision, UTC. */
  readonly receivedAt: string;
}

export class FakeRecordStore implements RecordStore {
  readonly rows: StoredRecord[] = [];
  /**
   * The submission log, at the real grain: one row per *submitted* record, whether it was created or
   * deduplicated. Modelled faithfully rather than canned, like the dedupe and cursor semantics
   * below, because that grain is the whole design — a fake that only logged created records would
   * let a 1:1 implementation pass every test here.
   */
  readonly submissions: SubmissionRow[] = [];
  /** Counts calls so tests can assert that storage was never reached. */
  insertCalls = 0;
  listCalls = 0;
  /** When set, every operation rejects with it. */
  failWith: Error | null = null;

  private nextId = 1;

  insert(principal: WritePrincipal, receivedAt: Date, records: readonly NewRecord[], provenance: Provenance): Promise<InsertOutcome[]> {
    this.insertCalls++;
    if (this.failWith !== null) return Promise.reject(this.failWith);

    const outcomes = records.map((record) => {
      // Logged before the dedupe verdict, and unconditionally: a duplicate is a submission that
      // happened, and seeing it is the point of the table. See `docs/database.md`.
      this.submissions.push({
        ...provenance,
        appId: principal.appId,
        instanceId: principal.instanceId,
        keyId: principal.keyId,
        clientId: record.clientId,
        // Neither is coarsened here, which is exactly what separates this table from `rows` below.
        createdAt: record.createdAt,
        receivedAt: receivedAt.toISOString(),
      });

      // Dedupe is scoped to the installation -- the (app_id, instance_id) pair -- and never to
      // instance_id alone: that is `default` for most apps, so two apps at the same instance would
      // collide and the second one's records would be dropped as acknowledged duplicates.
      const exists = this.rows.some(
        (row) => row.app_id === principal.appId && row.instance_id === principal.instanceId && row.client_id === record.clientId,
      );
      if (exists) return 'duplicate' as const;

      this.rows.push({
        id: this.nextId++,
        app_id: principal.appId,
        instance_id: principal.instanceId,
        client_id: record.clientId,
        // Both timestamps are coarsened to a date and the exact times discarded, exactly as the D1
        // adapter does. `created_date` stays in the client's local frame; `received_date` is UTC.
        created_date: localDateOf(record.createdAt),
        received_date: receivedAt.toISOString().slice(0, 10),
        engine_version: record.engineVersion,
        content_version: record.contentVersion,
        app_data: JSON.parse(record.appDataJson) as unknown,
      });
      return 'created' as const;
    });

    return Promise.resolve(outcomes);
  }

  list(principal: ReadPrincipal, query: ListQuery): Promise<ListPage> {
    this.listCalls++;
    if (this.failWith !== null) return Promise.reject(this.failWith);

    const matching = this.rows
      // The scope, not a filter: a read key sees its own installation and nothing else. Applied
      // before anything the caller chose, because nothing the caller chooses can widen it.
      .filter((row) => row.app_id === principal.appId && row.instance_id === principal.instanceId)
      .filter((row) => row.id > query.afterId)
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

/**
 * `keyId` is distinct on every principal below, and deliberately not equal to anything else about
 * them: the submission log records which key wrote a record, and a fixture where the ids happened to
 * line up with an index or an installation would let a store that logged the wrong number pass.
 */
export const WRITE_A: WritePrincipal = {
  kind: 'write',
  appId: 'app-1',
  instanceId: 'instance-a',
  keyId: 11,
};

/** Same app as A, different instance. */
export const WRITE_B: WritePrincipal = {
  kind: 'write',
  appId: 'app-1',
  instanceId: 'instance-b',
  keyId: 22,
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
  keyId: 33,
};

/** Reads installation A — the same installation {@link WRITE_A} writes to. */
export const READ_A: ReadPrincipal = { kind: 'read', appId: 'app-1', instanceId: 'instance-a', keyId: 44 };

/** Reads installation C. Its existence is what lets a spec prove one read key cannot see another's. */
export const READ_C: ReadPrincipal = { kind: 'read', appId: 'app-2', instanceId: 'instance-a', keyId: 55 };

export const KEY_A = 'key-write-a';
export const KEY_B = 'key-write-b';
export const KEY_C = 'key-write-c';
export const KEY_READ = 'key-read-a';
export const KEY_READ_C = 'key-read-c';

export const FIXED_NOW = new Date('2026-07-15T12:00:00.000Z');

/** The date {@link FIXED_NOW} coarsens to — every record written through {@link makeDeps}. */
export const FIXED_RECEIVED_DATE = '2026-07-15';

/**
 * A `created_at` from an exhibit whose clock is badly wrong — the dead-RTC-reporting-1970 case that
 * `created_date`/`received_date` exist to keep visible.
 *
 * Worth having as a fixture because {@link validRecord}'s `created_at` and {@link FIXED_NOW} both
 * fall on {@link FIXED_RECEIVED_DATE}: with only those, an implementation that swapped the two
 * columns — or wrote the server's date into both — would pass every assertion. This is the value
 * that tells them apart.
 */
export const SKEWED_CREATED_AT = '1970-01-01T04:00:00+01:00';
export const SKEWED_CREATED_DATE = '1970-01-01';

export interface TestDeps extends Deps {
  readonly keyStore: FakeKeyStore;
  readonly recordStore: FakeRecordStore;
}

/** Deps pre-wired with three write keys and two read keys, on three installations. */
export function makeDeps(): TestDeps {
  const keyStore = new FakeKeyStore()
    .set(KEY_A, WRITE_A)
    .set(KEY_B, WRITE_B)
    .set(KEY_C, WRITE_C)
    .set(KEY_READ, READ_A)
    .set(KEY_READ_C, READ_C);

  // `newSubmissionId` draws from the same counter as `uuid()`, for the reason `Deps` documents: the
  // real `crypto.randomUUID` would make a failure unreproducible. Every POST still gets a distinct
  // id, since the counter only ever moves forward.
  return { keyStore, recordStore: new FakeRecordStore(), now: () => FIXED_NOW, newSubmissionId: uuid };
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
