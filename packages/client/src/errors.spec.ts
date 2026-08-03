import { describe, expect, it } from 'vitest';
import { ApiError, TransportError, ValidationError } from './errors';
import { createReadClient } from './read-client';
import { createWriteClient } from './write-client';
import { createFakeStorage, createFetchStub, errorResponse } from './test-support';

const SECRET = 'nb_live_9f3c2a71b4e8d05c6a1f';

describe('the three classes', () => {
  it('are distinguishable, and keep their names past a minifier', () => {
    const api = new ApiError(503, 'unavailable', 'try later', 30_000);
    const transport = new TransportError('offline', { cause: new Error('ENOTFOUND'), timedOut: true });
    const validation = new ValidationError('app_data', 'too big');

    expect(api).toBeInstanceOf(Error);
    expect(api.name).toBe('ApiError');
    expect(api.status).toBe(503);
    expect(api.code).toBe('unavailable');
    expect(api.retryAfterMs).toBe(30_000);

    expect(transport.name).toBe('TransportError');
    expect(transport.timedOut).toBe(true);
    expect(transport.cause).toBeInstanceOf(Error);

    expect(validation.name).toBe('ValidationError');
    expect(validation.field).toBe('app_data');

    expect(api).not.toBeInstanceOf(TransportError);
    expect(validation).not.toBeInstanceOf(ApiError);
  });

  it('reports a null code when something other than the service answered', () => {
    // A `code` means the service spoke; `null` means something in between did — a proxy's error
    // page, a captive portal, a gateway. That is a real distinction, not a missing value.
    expect(new ApiError(502, null, 'HTTP 502').code).toBeNull();
  });

  it('defaults TransportError.timedOut to false', () => {
    expect(new TransportError('offline').timedOut).toBe(false);
  });
});

describe('the API key never leaves the header', () => {
  it('stays out of a read failure', async () => {
    const stub = createFetchStub(() => Promise.resolve(errorResponse(401, 'unauthorized', 'no such key')));
    const client = createReadClient({ baseUrl: 'https://nachbarin.example', apiKey: SECRET, fetch: stub.fetch });

    const error = await client.list().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(SECRET);
    expect((error as Error).message).not.toContain(SECRET);
    expect((error as Error).stack ?? '').not.toContain(SECRET);
    // It goes in exactly one place, and that place is a header.
    expect(stub.calls[0].headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(stub.calls[0].url).not.toContain(SECRET);
  });

  it('stays out of a write diagnostic', async () => {
    const events: unknown[] = [];
    const stub = createFetchStub(() => Promise.resolve(errorResponse(401, 'unauthorized', 'no such key')));
    const client = createWriteClient({
      baseUrl: 'https://nachbarin.example',
      apiKey: SECRET,
      engineVersion: 'engine-1.4.2',
      fetch: stub.fetch,
      storage: createFakeStorage(),
      storageKey: 'errors-spec',
      onDiagnostic: (event) => events.push(event),
    });

    client.write({ appData: { choice: 'bus' } });
    await client.flush();
    await client.close();

    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toContain(SECRET);
  });
});
