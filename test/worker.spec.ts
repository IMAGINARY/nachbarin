/**
 * Exercises the real `src/index.ts` wiring through the Workers runtime.
 *
 * These run against the actual not-implemented stubs, so they cover routing, authentication and
 * the error boundary only. Everything that needs a working store lives in the handler specs, which
 * inject fakes.
 */

import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/index';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('worker wiring', () => {
  // The handler takes only a request: there are no bindings to read and nothing to hand to
  // `ctx.waitUntil` yet, so `env` and `ctx` return to this call once storage is wired up.
  it('404s an unknown path (unit style)', async () => {
    const response = await worker.fetch(new IncomingRequest('https://example.com/'));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found', message: 'unknown endpoint' });
  });

  it('404s an unknown path (integration style)', async () => {
    const response = await SELF.fetch('https://example.com/');
    expect(response.status).toBe(404);
  });

  // Reached without storage, because routing and auth both precede it.
  it('401s an unauthenticated write', async () => {
    const response = await SELF.fetch('https://example.com/v1/records', { method: 'POST' });

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('405s a bad method with Allow', async () => {
    const response = await SELF.fetch('https://example.com/v1/records', { method: 'DELETE' });

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, POST');
  });

  // Proves the stub is wired in and that NotImplementedError maps at the error boundary. This is
  // the test that flips to a real assertion once storage exists.
  it('501s once a request needs storage', async () => {
    const response = await SELF.fetch('https://example.com/v1/records', {
      method: 'POST',
      headers: { authorization: 'Bearer any-key', 'content-type': 'application/json' },
      body: JSON.stringify({ records: [] }),
    });

    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({ error: 'not_implemented' });
  });

  it('501s a read that needs storage', async () => {
    const response = await SELF.fetch('https://example.com/v1/records', {
      headers: { authorization: 'Bearer any-key' },
    });
    expect(response.status).toBe(501);
  });

  it('responds with JSON and a charset', async () => {
    const response = await SELF.fetch('https://example.com/');
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
  });
});
