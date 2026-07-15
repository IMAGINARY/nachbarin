import { describe, expect, it } from 'vitest';
import { handleRequest } from '../src/app';
import { KEY_A, makeDeps } from './fakes';

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
    for (const method of ['DELETE', 'PUT', 'PATCH', 'HEAD', 'OPTIONS']) {
      const response = await handleRequest(request('/v1/records', method), makeDeps());
      expect(response.status, method).toBe(405);
      expect(response.headers.get('allow'), method).toBe('GET, POST');
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
