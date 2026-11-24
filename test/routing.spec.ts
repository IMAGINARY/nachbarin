import { describe, expect, it } from 'vitest';
import { handleRequest } from '../src/app';
import { StorageUnavailableError } from '../src/storage';
import { getRequest, KEY_A, makeDeps, postRequest, type TestDeps, validRecord } from './fakes';

const request = (url: string, method = 'GET', key: string | null = KEY_A) =>
  new Request(`https://example.com${url}`, {
    method,
    headers: key === null ? {} : { authorization: `Bearer ${key}` },
  });

describe('routing', () => {
  it('404s unknown paths', async () => {
    for (const path of ['/', '/v1', '/v2/records', '/v1/records/extra']) {
      const response = await handleRequest(request(path), makeDeps());
      expect(response.status, path).toBe(404);
    }
  });

  // Configured-once clients are better served by a loud 404 at integration time than by two
  // permanently valid spellings of the same URL.
  it('404s a trailing slash rather than normalizing it', async () => {
    expect((await handleRequest(request('/v1/records/'), makeDeps())).status).toBe(404);
  });

  // Regression: switching on method and path together would answer 404 here. The resource exists;
  // only the method is wrong.
  it('405s a known path with an unsupported method, and advertises Allow', async () => {
    for (const method of ['DELETE', 'PUT', 'PATCH', 'HEAD']) {
      const response = await handleRequest(request('/v1/records', method), makeDeps());
      expect(response.status, method).toBe(405);
      expect(response.headers.get('allow'), method).toBe('GET, POST, OPTIONS');
    }
  });

  it('routes before authenticating, so an unknown path needs no key', async () => {
    const deps = makeDeps();
    const response = await handleRequest(request('/nonsense', 'GET', null), deps);
    expect(response.status).toBe(404);
    expect(deps.recordStore.insertCalls).toBe(0);
  });

  it('returns JSON with a charset on errors', async () => {
    const response = await handleRequest(request('/'), makeDeps());
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await response.json()).toEqual({ error: 'not_found', message: 'unknown endpoint' });
  });
});

// Regression: kiosk pages run on `http://localhost` or `file:`, never on the Worker's origin. Before
// this, a browser's preflight got a 405 and every POST from a kiosk was blocked. The client saw only
// a NetworkError and retried until the nightly power-off lost the queue.
describe('CORS', () => {
  const preflight = (path = '/v1/records') =>
    new Request(`https://example.com${path}`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type',
      },
    });

  it('answers a preflight with 204 and no key, without touching storage', async () => {
    const deps = makeDeps();
    const response = await handleRequest(preflight(), deps);

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-methods')).toBe('GET, POST');
    expect(response.headers.get('access-control-allow-headers')).toBe('authorization, content-type');
    expect(response.headers.get('access-control-max-age')).toBe('7200');
    expect(await response.text()).toBe('');
    expect(deps.recordStore.insertCalls).toBe(0);
  });

  it('still logs a preflight as one request line', async () => {
    const deps = makeDeps();
    await handleRequest(preflight(), deps);
    expect(deps.log.only()).toMatchObject({ level: 'info', fields: { event: 'request', method: 'OPTIONS', status: 204 } });
  });

  // An unknown path stays a 404, preflight or not. The resource does not exist.
  it('404s a preflight on an unknown path', async () => {
    expect((await handleRequest(preflight('/v1/nope'), makeDeps())).status).toBe(404);
  });

  // A response the browser withholds is as bad as a blocked request. The client would never see the
  // 200's results, and never see a 401, 413 or 503 either.
  it('allows any origin and exposes Retry-After on every response, errors included', async () => {
    const cases: [string, Request, (deps: TestDeps) => void][] = [
      ['200 POST', postRequest({ records: [validRecord()] }), () => {}],
      ['200 GET', getRequest(), () => {}],
      ['401', request('/v1/records', 'POST', null), () => {}],
      ['404', request('/'), () => {}],
      ['405', request('/v1/records', 'DELETE'), () => {}],
      ['500', postRequest({ records: [validRecord()] }), (d) => (d.recordStore.failWith = new Error('boom'))],
      ['503', postRequest({ records: [validRecord()] }), (d) => (d.recordStore.failWith = new StorageUnavailableError())],
    ];
    for (const [label, req, arrange] of cases) {
      const deps = makeDeps();
      arrange(deps);
      const response = await handleRequest(req, deps);
      expect(response.headers.get('access-control-allow-origin'), label).toBe('*');
      expect(response.headers.get('access-control-expose-headers'), label).toBe('Retry-After');
    }
  });
});
