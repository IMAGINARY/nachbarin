import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './errors';
import { getRecords, normalizeBaseUrl, parseRetryAfterMs, postRecords, type Transport } from './transport';
import {
  createFetchStub,
  errorResponse,
  type FetchStub,
  jsonResponse,
  neverSettles,
  submittedRecords,
  wireRecord,
  writeResponse,
} from './test-support';

function transportWith(stub: FetchStub, overrides: Partial<Transport> = {}): Transport {
  return { baseUrl: 'https://nachbarin.example', apiKey: 'write-key', fetch: stub.fetch, timeoutMs: 30_000, ...overrides };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('normalizeBaseUrl', () => {
  it('keeps a path prefix, which .origin would silently discard', () => {
    // Behind https://api.museum.org/nachbarin/ every request would 404 — and from the outside that
    // looks exactly like a wrong key.
    expect(normalizeBaseUrl('https://api.museum.org/nachbarin/')).toBe('https://api.museum.org/nachbarin');
    expect(normalizeBaseUrl('https://api.museum.org/nachbarin')).toBe('https://api.museum.org/nachbarin');
  });

  it('strips query, fragment and trailing slashes', () => {
    expect(normalizeBaseUrl('https://nachbarin.example/?x=1#y')).toBe('https://nachbarin.example');
    expect(normalizeBaseUrl('https://nachbarin.example///')).toBe('https://nachbarin.example');
  });

  it('refuses a relative URL', () => {
    expect(() => normalizeBaseUrl('/v1/records')).toThrow();
  });
});

describe('parseRetryAfterMs', () => {
  it('honours delta-seconds', () => {
    expect(parseRetryAfterMs('30')).toBe(30_000);
    expect(parseRetryAfterMs(' 30 ')).toBe(30_000);
    expect(parseRetryAfterMs('0')).toBe(0);
  });

  it('ignores the HTTP-date form and anything else', () => {
    // The service only ever sends seconds; a date form would come from an intermediary whose clock
    // is not ours to trust, so the caller's own ladder is the safer answer.
    expect(parseRetryAfterMs('Wed, 21 Oct 2026 07:28:00 GMT')).toBeNull();
    expect(parseRetryAfterMs('soon')).toBeNull();
    expect(parseRetryAfterMs('-5')).toBeNull();
    expect(parseRetryAfterMs('1.5')).toBeNull();
    expect(parseRetryAfterMs(null)).toBeNull();
  });
});

describe('postRecords: the request', () => {
  it('sends a bearer token, JSON, and the records verbatim', async () => {
    const stub = createFetchStub(() => Promise.resolve(writeResponse('created')));
    const record = wireRecord();

    await postRecords(transportWith(stub), [record]);

    const [call] = stub.calls;
    expect(call.url).toBe('https://nachbarin.example/v1/records');
    expect(call.method).toBe('POST');
    expect(call.headers.authorization).toBe('Bearer write-key');
    expect(call.headers['content-type']).toBe('application/json');
    expect(submittedRecords(call)).toEqual([record]);
  });

  it('omits content_version rather than sending null', async () => {
    const stub = createFetchStub(() => Promise.resolve(writeResponse('created')));
    await postRecords(transportWith(stub), [wireRecord()]);

    expect(call0(stub)).not.toHaveProperty('content_version');
  });

  function call0(stub: FetchStub): Record<string, unknown> {
    return submittedRecords(stub.calls[0])[0] as unknown as Record<string, unknown>;
  }
});

describe('postRecords: success', () => {
  it('returns the results when the body matches what was sent', async () => {
    const stub = createFetchStub(() => Promise.resolve(writeResponse('created', 'duplicate')));
    const disposition = await postRecords(transportWith(stub), [wireRecord(), wireRecord()]);

    expect(disposition.kind).toBe('results');
    if (disposition.kind !== 'results') return;
    expect(disposition.results.map((r) => r.status)).toEqual(['created', 'duplicate']);
  });
});

describe('postRecords: a 2xx that proves nothing', () => {
  it.each([
    [
      'a captive portal HTML page',
      () => new Response('<html>Sign in to guest wifi</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    ],
    ['a JSON array', () => jsonResponse([])],
    ['an object with no results', () => jsonResponse({ ok: true })],
    ['results that are not an array', () => jsonResponse({ results: 'created' })],
    ['a length mismatch', () => writeResponse('created')],
    [
      'an unknown status word',
      () =>
        jsonResponse({
          results: [
            { client_id: null, status: 'stored' },
            { client_id: null, status: 'created' },
          ],
        }),
    ],
    ['a missing status', () => jsonResponse({ results: [{ client_id: null }, { client_id: null, status: 'created' }] })],
    ['a non-object result entry', () => jsonResponse({ results: [null, { client_id: null, status: 'created' }] })],
    ['an empty body', () => new Response('', { status: 200 })],
    ['a 204', () => new Response(null, { status: 204 })],
  ])('keeps every record when the answer is %s', async (_label, make) => {
    const stub = createFetchStub(() => Promise.resolve(make()));
    const disposition = await postRecords(transportWith(stub), [wireRecord(), wireRecord()]);

    expect(disposition.kind).toBe('retry');
    if (disposition.kind !== 'retry') return;
    expect(disposition.reason).toBe('protocol');
  });
});

describe('postRecords: refusals', () => {
  it.each([
    [400, 'invalid_request'],
    [400, 'invalid_json'],
    [400, 'batch_too_large'],
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [405, 'method_not_allowed'],
    [415, 'unsupported_media_type'],
    [429, null],
    [500, 'internal_error'],
    [502, null],
    [504, null],
  ])('keeps every record on %i %s', async (status, code) => {
    // Every one of these is recoverable — a key rotation mid-flight, a fix the operator ships, a
    // mangling intermediary, a redeploy. Dropping is not.
    const stub = createFetchStub(() => Promise.resolve(code === null ? new Response('nope', { status }) : errorResponse(status, code)));
    const disposition = await postRecords(transportWith(stub), [wireRecord(), wireRecord()]);

    expect(disposition.kind).toBe('retry');
    if (disposition.kind !== 'retry') return;
    expect(disposition.status).toBe(status);
    expect(disposition.code).toBe(code);
  });

  it('carries Retry-After off a 503', async () => {
    const stub = createFetchStub(() =>
      Promise.resolve(errorResponse(503, 'unavailable', 'storage is unavailable', { 'retry-after': '30' })),
    );
    const disposition = await postRecords(transportWith(stub), [wireRecord()]);

    expect(disposition.kind).toBe('retry');
    if (disposition.kind !== 'retry') return;
    expect(disposition.retryAfterMs).toBe(30_000);
  });

  it('keeps a batch of two on a 413', async () => {
    const stub = createFetchStub(() => Promise.resolve(errorResponse(413, 'payload_too_large')));
    const disposition = await postRecords(transportWith(stub), [wireRecord(), wireRecord()]);

    expect(disposition.kind).toBe('retry');
  });

  it('drops a batch of one on a 413 — the only terminal 4xx there is', async () => {
    const stub = createFetchStub(() => Promise.resolve(errorResponse(413, 'payload_too_large', 'request body exceeds 8388608 bytes')));
    const disposition = await postRecords(transportWith(stub), [wireRecord()]);

    expect(disposition.kind).toBe('drop');
    if (disposition.kind !== 'drop') return;
    expect(disposition.code).toBe('payload_too_large');
  });
});

describe('postRecords: the network', () => {
  it('keeps every record when fetch rejects', async () => {
    const stub = createFetchStub(() => Promise.reject(new Error('getaddrinfo ENOTFOUND')));
    const disposition = await postRecords(transportWith(stub), [wireRecord()]);

    expect(disposition.kind).toBe('retry');
    if (disposition.kind !== 'retry') return;
    expect(disposition.reason).toBe('network');
  });

  it('times out, and says so', async () => {
    const stub = createFetchStub(() => neverSettles());
    const promise = postRecords(transportWith(stub, { timeoutMs: 5_000 }), [wireRecord()]);

    await vi.advanceTimersByTimeAsync(5_000);
    const disposition = await promise;

    expect(disposition.kind).toBe('retry');
    if (disposition.kind !== 'retry') return;
    expect(disposition.reason).toBe('timeout');
  });

  it('aborts the request it gave up on', async () => {
    let seen: AbortSignal | undefined;
    const stub = createFetchStub(() => neverSettles());
    const spied: Transport = {
      ...transportWith(stub, { timeoutMs: 1_000 }),
      fetch: (_input, init) => {
        seen = init?.signal ?? undefined;
        return neverSettles();
      },
    };

    const promise = postRecords(spied, [wireRecord()]);
    await vi.advanceTimersByTimeAsync(1_000);
    await promise;

    expect(seen?.aborted).toBe(true);
  });

  it('clears the timeout timer once the request has answered', async () => {
    // A timer left armed per request is a leak on a client that makes one every sixty seconds for
    // months, and in Node it also holds the event loop open long after the work is done.
    const stub = createFetchStub(() => Promise.resolve(writeResponse('created')));
    const disposition = await postRecords(transportWith(stub, { timeoutMs: 1_000 }), [wireRecord()]);

    expect(disposition.kind).toBe('results');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never throws, whatever happens', async () => {
    // `flush()` promises never to reject, and that promise rests on this one. A non-Error rejection
    // is part of the point: `fetch` implementations in the wild throw strings and DOMExceptions, and
    // a client that only handled `Error` would take a Node process down with an unhandled rejection.
    const outcomes: (() => Promise<Response>)[] = [
      () => Promise.reject(new Error('boom')),
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- deliberately not an Error
      () => Promise.reject('a string'),
      () => Promise.resolve(new Response('{', { status: 200 })),
    ];

    for (const outcome of outcomes) {
      const stub = createFetchStub(outcome);
      await expect(postRecords(transportWith(stub), [wireRecord()])).resolves.toBeDefined();
    }
  });
});

describe('getRecords', () => {
  const page = { records: [], next_after_id: 0, has_more: false };

  it('sends only the parameters that were given', async () => {
    const stub = createFetchStub(() => Promise.resolve(jsonResponse(page)));
    await getRecords(transportWith(stub), {});

    expect(stub.calls[0].url).toBe('https://nachbarin.example/v1/records');
    expect(stub.calls[0].headers.authorization).toBe('Bearer write-key');
  });

  it('encodes the filters it was given, and never app or instance', async () => {
    // Scope comes from the key. `?app=` is an unknown parameter and a hard 400, which is the point.
    const stub = createFetchStub(() => Promise.resolve(jsonResponse(page)));
    await getRecords(transportWith(stub), { afterId: 184002, limit: 500, engineVersion: 'engine 1.4', contentVersion: 'sha256:ab' });

    const url = new URL(stub.calls[0].url);
    expect([...url.searchParams.keys()].sort()).toEqual(['after_id', 'content_version', 'engine_version', 'limit']);
    expect(url.searchParams.get('after_id')).toBe('184002');
    expect(url.searchParams.get('engine_version')).toBe('engine 1.4');
  });

  it('omits after_id at the beginning of the stream', async () => {
    const stub = createFetchStub(() => Promise.resolve(jsonResponse(page)));
    await getRecords(transportWith(stub), { afterId: 0 });

    expect(new URL(stub.calls[0].url).searchParams.has('after_id')).toBe(false);
  });

  it('refuses a cursor or limit the service would reject, without a round trip', async () => {
    const stub = createFetchStub(() => Promise.resolve(jsonResponse(page)));

    await expect(getRecords(transportWith(stub), { afterId: -1 })).rejects.toBeInstanceOf(ApiError);
    await expect(getRecords(transportWith(stub), { limit: 0 })).rejects.toBeInstanceOf(ApiError);
    await expect(getRecords(transportWith(stub), { limit: 1001 })).rejects.toBeInstanceOf(ApiError);
    expect(stub.calls).toHaveLength(0);
  });

  it('throws ApiError with the code the service sent', async () => {
    const stub = createFetchStub(() => Promise.resolve(errorResponse(403, 'forbidden', 'this key may not read')));

    await expect(getRecords(transportWith(stub), {})).rejects.toMatchObject({ name: 'ApiError', status: 403, code: 'forbidden' });
  });

  it('reports a null code when something other than the service answered', async () => {
    const stub = createFetchStub(() => Promise.resolve(new Response('<html>portal</html>', { status: 502 })));

    await expect(getRecords(transportWith(stub), {})).rejects.toMatchObject({ status: 502, code: null });
  });

  it('refuses a 200 that is not a page', async () => {
    const stub = createFetchStub(() => Promise.resolve(new Response('<html>Sign in</html>', { status: 200 })));

    await expect(getRecords(transportWith(stub), {})).rejects.toBeInstanceOf(ApiError);
  });

  it('refuses a page whose records are not records', async () => {
    const stub = createFetchStub(() => Promise.resolve(jsonResponse({ records: [{ id: 1 }], next_after_id: 1, has_more: false })));

    await expect(getRecords(transportWith(stub), {})).rejects.toBeInstanceOf(ApiError);
  });

  it('throws TransportError, with a cause, when the request never landed', async () => {
    const cause = new Error('ECONNREFUSED');
    const stub = createFetchStub(() => Promise.reject(cause));

    await expect(getRecords(transportWith(stub), {})).rejects.toMatchObject({ name: 'TransportError', cause });
  });

  it("propagates the caller's own abort verbatim", async () => {
    const controller = new AbortController();
    const stub = createFetchStub(() => neverSettles());
    const promise = getRecords(transportWith(stub), { signal: controller.signal });

    const reason = new Error('caller changed their mind');
    controller.abort(reason);

    await expect(promise).rejects.toBe(reason);
  });

  it('does not even start when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('already done'));
    const stub = createFetchStub(() => Promise.resolve(jsonResponse(page)));

    await expect(getRecords(transportWith(stub), { signal: controller.signal })).rejects.toThrow('already done');
    expect(stub.calls).toHaveLength(0);
  });
});
