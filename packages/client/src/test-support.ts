/**
 * Doubles shared by this package's specs.
 *
 * Not a `*.spec.ts` file, so vitest does not collect it, and nothing in `index.ts` imports it, so the
 * bundler never sees it either. It is still subject to the strict lint rules the rest of `src/` gets,
 * which is intentional — a helper that reached for a browser global would hide exactly the portability
 * bug those rules exist to catch.
 *
 * There is no fetch-mocking library here and none is wanted. `ClientOptions.fetch` is an injection
 * point precisely so that a stub is nine lines rather than a dependency, and a museum kiosk's bundle
 * is not a place to acquire a dependency tree.
 */

import type { QueueStorage } from './storage';
import type { RecordStatus, WireRecord } from './protocol';

export interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
}

export interface FetchStub {
  readonly fetch: typeof globalThis.fetch;
  readonly calls: readonly FetchCall[];
}

/**
 * A `fetch` that records what it was asked and answers with whatever `handler` returns.
 *
 * The handler returns a promise rather than a value so a spec can hand back one that never settles —
 * which is how the request timeout gets exercised without waiting for it.
 */
export function createFetchStub(handler: (call: FetchCall, index: number) => Promise<Response>): FetchStub {
  const calls: FetchCall[] = [];

  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });

    const call: FetchCall = {
      url,
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : null,
    };
    calls.push(call);

    return handler(call, calls.length - 1);
  };

  return { fetch, calls };
}

export function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json; charset=utf-8', ...init.headers },
  });
}

/** A well-formed write response with one result per status given. */
export function writeResponse(...statuses: readonly (RecordStatus | { status: 'rejected'; error: string; message: string })[]): Response {
  return jsonResponse({
    results: statuses.map((entry) =>
      typeof entry === 'string'
        ? { client_id: null, status: entry }
        : { client_id: null, status: 'rejected', error: entry.error, message: entry.message },
    ),
  });
}

export function errorResponse(status: number, error: string, message?: string, headers: Record<string, string> = {}): Response {
  return jsonResponse(message === undefined ? { error } : { error, message }, { status, headers });
}

/** A promise that never settles — for driving the request-timeout path. */
export function neverSettles(): Promise<Response> {
  return new Promise<Response>(() => {
    // deliberately empty
  });
}

export interface FakeStorage extends QueueStorage {
  value: string | null;
  readonly writes: number;
  /** When set, `write` throws this many more times before working again. */
  failNextWrites: number;
  /** When true, `write` always throws. */
  failAlways: boolean;
}

/** A `QueueStorage` whose contents and failure behaviour a spec can steer. */
export function createFakeStorage(initial: string | null = null): FakeStorage {
  let writes = 0;

  const storage: FakeStorage = {
    value: initial,
    failNextWrites: 0,
    failAlways: false,
    get writes() {
      return writes;
    },
    read() {
      return storage.value;
    },
    write(next: string) {
      writes++;
      if (storage.failAlways || storage.failNextWrites > 0) {
        if (storage.failNextWrites > 0) storage.failNextWrites--;
        throw new Error('QuotaExceededError');
      }
      storage.value = next;
    },
  };

  return storage;
}

let counter = 0;

/** Deterministic, distinct, valid v4 UUIDs. `crypto.randomUUID` would make a failure unreproducible. */
export function testUuid(): string {
  counter++;
  return `3f8a0000-0000-4000-8000-${counter.toString(16).padStart(12, '0')}`;
}

export const FIXED_CREATED_AT = '2026-07-15T14:03:22+02:00';

export function wireRecord(overrides: Partial<WireRecord> = {}): WireRecord {
  return {
    client_id: testUuid(),
    created_at: FIXED_CREATED_AT,
    engine_version: 'engine-1.4.2',
    app_data: { choice: 'bus' },
    ...overrides,
  };
}

/** Reads the `records` array back out of a POST body a stub captured. */
export function submittedRecords(call: FetchCall): readonly WireRecord[] {
  return (JSON.parse(call.body ?? '{}') as { records?: WireRecord[] }).records ?? [];
}
