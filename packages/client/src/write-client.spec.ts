import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ValidationError } from './errors';
import { createWriteClient, type DiagnosticEvent, type RecordOutcome, type WriteClient, type WriteClientOptions } from './write-client';
import {
  createFakeStorage,
  createFetchStub,
  errorResponse,
  type FakeStorage,
  type FetchCall,
  type FetchStub,
  jsonResponse,
  neverSettles,
  submittedRecords,
  writeResponse,
} from './test-support';

const NOW = new Date('2026-07-15T12:00:00.000Z');

let keyCounter = 0;
const open: WriteClient[] = [];

interface Harness {
  readonly client: WriteClient;
  readonly stub: FetchStub;
  readonly storage: FakeStorage;
  readonly diagnostics: DiagnosticEvent[];
}

function makeClient(
  handler: (call: FetchCall, index: number) => Promise<Response>,
  overrides: Partial<WriteClientOptions> = {},
  storage: FakeStorage = createFakeStorage(),
): Harness {
  const stub = createFetchStub(handler);
  const diagnostics: DiagnosticEvent[] = [];

  const client = createWriteClient({
    baseUrl: 'https://nachbarin.example',
    apiKey: 'write-key',
    engineVersion: 'engine-1.4.2',
    fetch: stub.fetch,
    storage,
    storageKey: `key-${String(++keyCounter)}`,
    onDiagnostic: (event) => diagnostics.push(event),
    ...overrides,
  });

  open.push(client);
  return { client, stub, storage, diagnostics };
}

/**
 * A service that stores everything, answering with one result per record it was actually sent.
 *
 * Deriving the count from the request rather than hardcoding it is not a nicety: a stub that always
 * answered with one result would make every multi-record batch a length mismatch, and the client
 * would — correctly — refuse it. That looks like a client bug and is a stub bug.
 */
const ok = (call: FetchCall) => Promise.resolve(writeResponse(...submittedRecords(call).map(() => 'created' as const)));

/** A queue left behind by a previous page load: `count` records written while the network was down. */
async function seedQueue(count: number): Promise<FakeStorage> {
  const storage = createFakeStorage();
  const offline = makeClient(() => Promise.reject(new Error('offline')), {}, storage);

  for (let i = 0; i < count; i++) offline.client.write({ appData: i });
  await offline.client.flush();
  await offline.client.close();
  open.length = 0;

  return storage;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(async () => {
  while (open.length > 0) await open.pop()?.close();
  vi.useRealTimers();
});

describe('write', () => {
  it('returns a client_id and flushes immediately', async () => {
    const { client, stub } = makeClient(ok);
    const clientId = client.write({ appData: { choice: 'bus' } });

    await client.flush();

    expect(clientId).toMatch(/^[0-9a-f]{8}-/);
    expect(stub.calls).toHaveLength(1);
    expect(submittedRecords(stub.calls[0])[0].client_id).toBe(clientId);
    expect(client.state().queued).toBe(0);
  });

  it('is durable before it returns', () => {
    const { client, storage } = makeClient(() => neverSettles());
    client.write({ appData: 1 });

    // No await anywhere: the record is in storage by the time `write()` has returned, which is what
    // makes a reload one millisecond later survivable.
    expect(storage.value).toContain('"records"');
    expect(client.state().queued).toBe(1);
  });

  it('mints created_at with an offset, and lets the caller override both fields', async () => {
    const { client, stub } = makeClient(ok);
    client.write({ appData: 1, clientId: '3f8a1c2e-7b40-4d6a-9e11-0c5f8a2b3d41', createdAt: '2026-07-15T14:03:22+02:00' });
    await client.flush();

    const [record] = submittedRecords(stub.calls[0]);
    expect(record.client_id).toBe('3f8a1c2e-7b40-4d6a-9e11-0c5f8a2b3d41');
    expect(record.created_at).toBe('2026-07-15T14:03:22+02:00');
  });

  it('throws for a record the service could never accept', () => {
    // Synchronously, and not through `onResult` — which is best-effort and could be lost across a
    // reload, leaving a producer bug with nothing anywhere saying why.
    const { client, stub } = makeClient(ok);

    expect(() => client.write({ appData: undefined })).toThrow(ValidationError);
    expect(() => client.write({ appData: 1, engineVersion: '' })).toThrow(ValidationError);
    expect(() => client.write({ appData: 1, clientId: '00000000-0000-0000-0000-000000000000' })).toThrow(ValidationError);
    expect(() => client.write({ appData: 1, createdAt: '2026-02-30T00:00:00Z' })).toThrow(ValidationError);

    expect(client.state().queued).toBe(0);
    expect(stub.calls).toHaveLength(0);
  });

  it('refuses an explicit null content_version even when a default exists', () => {
    const { client } = makeClient(ok, { contentVersion: 'sha256:ab' });
    expect(() => client.write({ appData: 1, contentVersion: null as unknown as string })).toThrow(/omitted rather than null/);
  });

  it('applies the client-wide versions, and a per-record override', async () => {
    const { client, stub } = makeClient(ok, { contentVersion: 'sha256:ab' });
    client.write({ appData: 1 });
    await client.flush();
    client.write({ appData: 2, engineVersion: 'engine-2.0.0' });
    await client.flush();

    expect(submittedRecords(stub.calls[0])[0]).toMatchObject({ engine_version: 'engine-1.4.2', content_version: 'sha256:ab' });
    expect(submittedRecords(stub.calls[1])[0].engine_version).toBe('engine-2.0.0');
  });

  it('throws after close', async () => {
    const { client } = makeClient(ok);
    await client.close();
    expect(() => client.write({ appData: 1 })).toThrow(/closed/);
  });
});

describe('the flush cycle', () => {
  it('starts no second POST while one is in flight, and loses nothing written meanwhile', async () => {
    let release: ((response: Response) => void) | undefined;
    const { client, stub } = makeClient((call, index) =>
      index === 0 ? new Promise<Response>((resolve) => (release = resolve)) : ok(call),
    );

    client.write({ appData: 1 });
    await vi.advanceTimersByTimeAsync(0);
    client.write({ appData: 2 });
    client.write({ appData: 3 });

    expect(stub.calls).toHaveLength(1);
    expect(submittedRecords(stub.calls[0])).toHaveLength(1);

    release?.(writeResponse('created'));
    await client.flush();

    // The two written mid-flight went out in the cycle's next batch rather than being discarded
    // along with the snapshot the first batch was built from.
    expect(stub.calls).toHaveLength(2);
    expect(submittedRecords(stub.calls[1])).toHaveLength(2);
    expect(client.state().queued).toBe(0);
  });

  it('joins the cycle already running rather than starting another', async () => {
    const { client, stub } = makeClient(ok);
    client.write({ appData: 1 });

    const [a, b] = await Promise.all([client.flush(), client.flush()]);

    expect(a).toBe(b);
    expect(stub.calls).toHaveLength(1);
  });

  it('continues to the next batch in the same cycle', async () => {
    // 250 restored records at 100 a batch, waiting a minute between them, is minutes to drain on a
    // machine that reloads every three to five. Everything past batch one would never be sent.
    const storage = await seedQueue(250);

    const { client, stub } = makeClient(ok, {}, storage);
    const result = await client.flush();

    expect(stub.calls).toHaveLength(3);
    expect(submittedRecords(stub.calls[0])).toHaveLength(100);
    expect(submittedRecords(stub.calls[2])).toHaveLength(50);
    expect(result.batches).toBe(3);
    expect(client.state().queued).toBe(0);
  });

  it('stops at maxBatchesPerFlush and comes back for the rest', async () => {
    const storage = await seedQueue(250);

    const { client } = makeClient(ok, { maxBatchesPerFlush: 2 }, storage);
    const result = await client.flush();

    expect(result.batches).toBe(2);
    expect(result.queued).toBe(50);
    expect(result.ok).toBe(true);
  });

  it('never rejects, whatever the network does', async () => {
    // The timer path `void`s this promise, and an unhandled rejection kills a Node process.
    const { client } = makeClient(() => Promise.reject(new Error('boom')));
    client.write({ appData: 1 });

    await expect(client.flush()).resolves.toMatchObject({ ok: false });
  });
});

describe('results', () => {
  it('matches results to records by position, not by client_id', async () => {
    // A batch may legitimately carry the same client_id twice, so position is the only total
    // mapping — and each copy can get a different verdict.
    const shared = '3f8a1c2e-7b40-4d6a-9e11-0c5f8a2b3d41';
    const outcomes: RecordOutcome[] = [];
    const { client } = makeClient(() =>
      Promise.resolve(
        jsonResponse({
          results: [
            { client_id: shared, status: 'created' },
            { client_id: shared, status: 'duplicate' },
          ],
        }),
      ),
    );

    client.write({ appData: 1, clientId: shared }, { onResult: (o) => outcomes.push(o) });
    await vi.advanceTimersByTimeAsync(0);
    client.write({ appData: 2, clientId: shared }, { onResult: (o) => outcomes.push(o) });
    await client.flush();
    await client.flush();

    expect(outcomes.map((o) => o.status)).toEqual(['created', 'duplicate']);
  });

  it('reports our own client_id, never the echo', async () => {
    // The echo is null whenever the submitted id was unusable, so it is never the thing to report.
    let outcome: RecordOutcome | undefined;
    const { client } = makeClient(() =>
      Promise.resolve(jsonResponse({ results: [{ client_id: null, status: 'rejected', error: 'invalid_field' }] })),
    );

    const clientId = client.write({ appData: 1 }, { onResult: (o) => (outcome = o) });
    await client.flush();

    expect(outcome).toEqual({ status: 'rejected', clientId, error: 'invalid_field', message: undefined });
  });

  it('drops created, duplicate and rejected alike — all three are permanent', async () => {
    const storage = await seedQueue(3);
    const { client } = makeClient(
      () => Promise.resolve(writeResponse('created', 'duplicate', { status: 'rejected', error: 'invalid_field', message: 'no' })),
      {},
      storage,
    );

    await client.flush();

    expect(client.state().queued).toBe(0);
  });

  it('fires each callback at most once', async () => {
    const seen: RecordOutcome[] = [];
    const { client } = makeClient(ok);
    client.write({ appData: 1 }, { onResult: (o) => seen.push(o) });

    await client.flush();
    await client.flush();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(seen).toHaveLength(1);
  });

  it('survives a callback that throws, without losing the timer', async () => {
    const { client, stub } = makeClient(ok);
    client.write(
      { appData: 1 },
      {
        onResult: () => {
          throw new Error('consumer bug');
        },
      },
    );

    await expect(client.flush()).resolves.toMatchObject({ ok: true });

    client.write({ appData: 2 });
    await client.flush();
    expect(stub.calls).toHaveLength(2);
  });
});

describe('never dropping on a 4xx', () => {
  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [400, 'invalid_request'],
    [404, 'not_found'],
    [415, 'unsupported_media_type'],
    [500, 'internal_error'],
  ])('keeps the queue on %i %s', async (status, code) => {
    const { client } = makeClient(() => Promise.resolve(errorResponse(status, code)));
    client.write({ appData: 1 });

    const result = await client.flush();

    expect(result.ok).toBe(false);
    expect(client.state().queued).toBe(1);
  });

  it('keeps retrying a 401 and recovers when the key starts working', async () => {
    // A client that concluded "my credential is bad" from a key rotation mid-flight would discard a
    // day's records — and on hardware wiped nightly there is no upstream copy left to re-send.
    let working = false;
    const { client, stub } = makeClient(() => Promise.resolve(working ? writeResponse('created') : errorResponse(401, 'unauthorized')));

    client.write({ appData: 1 });
    await client.flush();
    expect(client.state().queued).toBe(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(stub.calls.length).toBeGreaterThan(1);
    expect(client.state().queued).toBe(1);

    working = true;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(client.state().queued).toBe(0);
  });

  it('keeps the queue when a captive portal answers 200 with a login page', async () => {
    const { client } = makeClient(() => Promise.resolve(new Response('<html>Sign in to guest wifi</html>', { status: 200 })));
    client.write({ appData: 1 });

    await client.flush();

    expect(client.state().queued).toBe(1);
  });

  it('keeps the queue when results do not line up with what was sent', async () => {
    // A mismatched length means no result can be attributed to any record, so acting on any of them
    // is a guess. Retrying the whole batch is free — client_id makes it idempotent.
    const storage = await seedQueue(3);
    const { client, diagnostics } = makeClient(() => Promise.resolve(writeResponse('created')), {}, storage);

    await client.flush();

    expect(client.state().queued).toBe(3);
    expect(diagnostics.some((event) => event.type === 'flush_failed' && event.reason === 'protocol')).toBe(true);
  });

  it('drops a lone record the service says is too large', async () => {
    let outcome: RecordOutcome | undefined;
    const { client } = makeClient(() => Promise.resolve(errorResponse(413, 'payload_too_large', 'too big')));

    client.write({ appData: 1 }, { onResult: (o) => (outcome = o) });
    await client.flush();

    expect(client.state().queued).toBe(0);
    expect(outcome).toMatchObject({ status: 'rejected', error: 'payload_too_large' });
  });
});

describe('the timer', () => {
  it('arms at construction for a queue left by the last page load', async () => {
    // After a reload nothing calls write(). A kiosk with no visitor for an hour would otherwise
    // never send what the last one left.
    const storage = await seedQueue(1);
    const { client, stub } = makeClient(ok, {}, storage);
    expect(stub.calls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(stub.calls.length).toBeGreaterThan(0);
    expect(client.state().queued).toBe(0);
  });

  it('clamps a delay computed against a clock that jumped', async () => {
    // A failing RTC makes `lastAttemptAt + interval - now` some hundreds of billions of
    // milliseconds, and a timer set to that never fires — on the one path whose job is to fire.
    const storage = await seedQueue(1);
    vi.setSystemTime(new Date('1998-01-01T00:00:00Z'));
    const { client, stub } = makeClient(ok, {}, storage);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(stub.calls.length).toBeGreaterThan(0);
    expect(client.state().queued).toBe(0);
  });

  it('arms nothing once the queue drains', async () => {
    const { client } = makeClient(ok);
    client.write({ appData: 1 });
    await client.flush();

    expect(client.state().queued).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('honours Retry-After exactly', async () => {
    const { client, stub } = makeClient(() => Promise.resolve(errorResponse(503, 'unavailable', 'try later', { 'retry-after': '30' })));
    client.write({ appData: 1 });
    await client.flush();
    expect(stub.calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(stub.calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(stub.calls).toHaveLength(2);
  });

  it('does not flush on write while backing off', async () => {
    // Otherwise a busy exhibit turns one failing endpoint into a request per visitor, which is the
    // behaviour backoff exists to prevent.
    const { client, stub } = makeClient(() => Promise.resolve(errorResponse(500, 'internal_error')));
    client.write({ appData: 1 });
    await client.flush();
    expect(stub.calls).toHaveLength(1);

    client.write({ appData: 2 });
    client.write({ appData: 3 });
    await vi.advanceTimersByTimeAsync(0);

    expect(stub.calls).toHaveLength(1);
  });

  it('reports the delay it actually used', async () => {
    const { client, diagnostics } = makeClient(() => Promise.resolve(errorResponse(503, 'unavailable', 'x', { 'retry-after': '30' })));
    client.write({ appData: 1 });
    await client.flush();

    const failure = diagnostics.find((event) => event.type === 'flush_failed');
    expect(failure).toMatchObject({ nextAttemptInMs: 30_000, status: 503, code: 'unavailable', failures: 1 });
  });

  it('stops entirely on close', async () => {
    const { client, stub } = makeClient(() => Promise.resolve(errorResponse(500, 'internal_error')));
    client.write({ appData: 1 });
    await client.flush();
    const before = stub.calls.length;

    await client.close();
    open.length = 0;

    await vi.advanceTimersByTimeAsync(600_000);

    expect(stub.calls).toHaveLength(before);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('eviction', () => {
  it('sheds the oldest past the record cap and says so', () => {
    const outcomes: RecordOutcome[] = [];
    const { client, diagnostics } = makeClient(() => neverSettles(), { maxQueueRecords: 2 });

    client.write({ appData: 1 }, { onResult: (o) => outcomes.push(o) });
    client.write({ appData: 2 });
    client.write({ appData: 3 });

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ status: 'evicted', reason: 'count' });
    expect(diagnostics).toContainEqual({ type: 'records_evicted', reason: 'count', count: 1 });
    expect(client.state().queued).toBe(2);
  });

  it('sheds records older than the age cap before flushing', async () => {
    const { client, stub } = makeClient(ok, { maxRecordAgeMs: 60_000 });
    client.write({ appData: 2 });
    await client.flush();
    const before = stub.calls.length;

    vi.setSystemTime(new Date(NOW.getTime() + 3_600_000));
    await client.flush();

    expect(stub.calls).toHaveLength(before);
    expect(client.state().queued).toBe(0);
  });
});

describe('degraded storage', () => {
  it('keeps working when the store refuses, and says so', async () => {
    const storage = createFakeStorage();
    storage.failAlways = true;
    const { client, diagnostics } = makeClient(ok, {}, storage);

    expect(() => client.write({ appData: 1 })).not.toThrow();
    await client.flush();

    expect(diagnostics.some((event) => event.type === 'storage_write_failed')).toBe(true);
    expect(client.state().queued).toBe(0);
  });

  it('reports a non-persistent queue at construction', () => {
    const { diagnostics } = makeClient(ok, { storage: null });
    expect(diagnostics).toContainEqual({ type: 'storage_not_persistent' });
  });

  it('reports which id source it got', () => {
    const { diagnostics } = makeClient(ok);
    expect(diagnostics.some((event) => event.type === 'id_source')).toBe(true);
  });
});

describe('one client per storage key', () => {
  it('refuses a second client on the same key', () => {
    const storage = createFakeStorage();
    makeClient(ok, { storageKey: 'shared' }, storage);

    // Two in-memory queues mirroring to one key, and two timers doing it — a React StrictMode
    // double-mount, a hot reload, a module constructing one twice. The symptom is vanishing records.
    expect(() => makeClient(ok, { storageKey: 'shared' }, storage)).toThrow(/already using the storage key/);
  });

  it('releases the key on close', async () => {
    const storage = createFakeStorage();
    const first = makeClient(ok, { storageKey: 'released' }, storage);
    await first.client.close();
    open.length = 0;

    expect(() => makeClient(ok, { storageKey: 'released' }, storage)).not.toThrow();
  });
});
