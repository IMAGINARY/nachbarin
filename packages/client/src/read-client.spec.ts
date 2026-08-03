import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './errors';
import type { StoredRecord } from './protocol';
import { createReadClient, type ReadClientOptions } from './read-client';
import { createFetchStub, errorResponse, type FetchCall, jsonResponse, neverSettles } from './test-support';

function record(id: number): StoredRecord {
  return {
    id,
    app_id: 'future-mobility-simulator',
    instance_id: 'default',
    client_id: `3f8a0000-0000-4000-8000-${id.toString(16).padStart(12, '0')}`,
    created_date: '2026-07-15',
    received_date: '2026-07-15',
    engine_version: 'engine-1.4.2',
    content_version: null,
    app_data: { choice: 'bus' },
  };
}

function page(records: readonly StoredRecord[], hasMore: boolean, nextAfterId?: number) {
  return {
    records,
    next_after_id: nextAfterId ?? (records.length > 0 ? records[records.length - 1].id : 0),
    has_more: hasMore,
  };
}

function makeClient(handler: (call: FetchCall, index: number) => Promise<Response>, overrides: Partial<ReadClientOptions> = {}) {
  const stub = createFetchStub(handler);
  const client = createReadClient({
    baseUrl: 'https://nachbarin.example',
    apiKey: 'read-key',
    fetch: stub.fetch,
    ...overrides,
  });
  return { client, stub };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('list', () => {
  it('returns a page', async () => {
    const { client } = makeClient(() => Promise.resolve(jsonResponse(page([record(1), record(2)], false))));
    const result = await client.list();

    expect(result.records).toHaveLength(2);
    expect(result.has_more).toBe(false);
  });

  it('passes app_data through untouched, whatever shape it has', async () => {
    // Opaque is the strongest rule in this service, and a client that reshaped a payload on the way
    // out would be the one place it stopped being true.
    const payload = { nested: [1, null, { deep: true }], n: 0 };
    const { client } = makeClient(() => Promise.resolve(jsonResponse(page([{ ...record(1), app_data: payload }], false))));

    expect((await client.list()).records[0].app_data).toEqual(payload);
  });
});

describe('failing fast, because somebody is waiting', () => {
  it.each([
    [400, 'invalid_request'],
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not_found'],
  ])('throws immediately on %i %s, with no retry', async (status, code) => {
    const { client, stub } = makeClient(() => Promise.resolve(errorResponse(status, code, 'nope')));

    await expect(client.list()).rejects.toMatchObject({ name: 'ApiError', status, code });
    expect(stub.calls).toHaveLength(1);
  });

  it('retries a 503 and then gives up', async () => {
    const { client, stub } = makeClient(() => Promise.resolve(errorResponse(503, 'unavailable', 'x', { 'retry-after': '30' })));
    const promise = client.list();
    const assertion = expect(promise).rejects.toBeInstanceOf(ApiError);

    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;

    // Three attempts in all: the original plus `readRetries`.
    expect(stub.calls).toHaveLength(3);
  });

  it('clamps Retry-After to seconds, not the half-minute the write client would wait', async () => {
    const { client, stub } = makeClient((_call, index) =>
      Promise.resolve(index === 0 ? errorResponse(503, 'unavailable', 'x', { 'retry-after': '30' }) : jsonResponse(page([], false))),
    );

    const promise = client.list();
    await vi.advanceTimersByTimeAsync(5_000);
    await promise;

    expect(stub.calls).toHaveLength(2);
  });

  it('recovers when a retryable failure clears', async () => {
    const { client } = makeClient((_call, index) =>
      Promise.resolve(index === 0 ? errorResponse(500, 'internal_error') : jsonResponse(page([record(1)], false))),
    );

    const promise = client.list();
    await vi.advanceTimersByTimeAsync(5_000);

    expect((await promise).records).toHaveLength(1);
  });

  it('wraps a network failure with its cause', async () => {
    const cause = new Error('ECONNREFUSED');
    const { client } = makeClient(() => Promise.reject(cause));

    const promise = client.list({ signal: undefined });
    const assertion = expect(promise).rejects.toMatchObject({ name: 'TransportError', cause });
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
  });

  it('does not retry its own argument check', async () => {
    const { client, stub } = makeClient(() => Promise.resolve(jsonResponse(page([], false))));

    await expect(client.list({ limit: 5000 })).rejects.toBeInstanceOf(ApiError);
    expect(stub.calls).toHaveLength(0);
  });
});

describe('listAll', () => {
  it('walks the cursor to the end', async () => {
    const { client, stub } = makeClient((call) => {
      const after = Number(new URL(call.url).searchParams.get('after_id') ?? '0');
      if (after === 0) return Promise.resolve(jsonResponse(page([record(1), record(2)], true)));
      if (after === 2) return Promise.resolve(jsonResponse(page([record(3)], true)));
      return Promise.resolve(jsonResponse(page([], false, 3)));
    });

    const ids: number[] = [];
    for await (const entry of client.listAll()) ids.push(entry.id);

    expect(ids).toEqual([1, 2, 3]);
    expect(stub.calls).toHaveLength(3);
  });

  it('does not stop at a short page — only has_more ends the walk', async () => {
    // A page can be short because the service truncated it to a response byte budget. Treating
    // `records.length < limit` as the end would abandon a download partway and report success.
    const { client } = makeClient((_call, index) =>
      Promise.resolve(index === 0 ? jsonResponse(page([record(1)], true)) : jsonResponse(page([record(2), record(3)], false))),
    );

    const ids: number[] = [];
    for await (const entry of client.listAll({ limit: 100 })) ids.push(entry.id);

    expect(ids).toEqual([1, 2, 3]);
  });

  it('throws rather than spinning when the cursor does not advance', async () => {
    // has_more true with an unmoved cursor and an empty page is an infinite loop that yields
    // nothing — the worst possible way to report a service bug.
    const { client } = makeClient(() => Promise.resolve(jsonResponse(page([], true, 0))));

    await expect(async () => {
      for await (const entry of client.listAll()) void entry;
    }).rejects.toThrow(/cursor did not advance/);
  });

  it('stops fetching when the caller breaks out', async () => {
    const { client, stub } = makeClient(() => Promise.resolve(jsonResponse(page([record(1)], true, 1))));

    for await (const entry of client.listAll()) {
      expect(entry.id).toBe(1);
      break;
    }

    expect(stub.calls).toHaveLength(1);
  });

  it('starts from the afterId it was given', async () => {
    const { client, stub } = makeClient(() => Promise.resolve(jsonResponse(page([], false, 184002))));

    for await (const entry of client.listAll({ afterId: 184002 })) void entry;

    expect(new URL(stub.calls[0].url).searchParams.get('after_id')).toBe('184002');
  });

  it('carries the filters onto every page', async () => {
    const { client, stub } = makeClient((call) => {
      const after = Number(new URL(call.url).searchParams.get('after_id') ?? '0');
      return Promise.resolve(after === 0 ? jsonResponse(page([record(1)], true)) : jsonResponse(page([], false, 1)));
    });

    for await (const entry of client.listAll({ engineVersion: 'engine-1.4.2' })) void entry;

    for (const call of stub.calls) {
      expect(new URL(call.url).searchParams.get('engine_version')).toBe('engine-1.4.2');
    }
  });

  it("honours the caller's abort mid-walk", async () => {
    const controller = new AbortController();
    const { client } = makeClient((_call, index) =>
      index === 0 ? Promise.resolve(jsonResponse(page([record(1)], true))) : neverSettles(),
    );

    const walk = (async () => {
      const ids: number[] = [];
      for await (const entry of client.listAll({ signal: controller.signal })) ids.push(entry.id);
      return ids;
    })();

    await vi.advanceTimersByTimeAsync(0);
    const reason = new Error('caller stopped');
    controller.abort(reason);

    await expect(walk).rejects.toBe(reason);
  });
});
