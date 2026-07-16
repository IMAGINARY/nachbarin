/**
 * Exercises the real `src/index.ts` wiring through the Workers runtime.
 *
 * Unlike the handler specs, these inject nothing: the key store is the real `D1KeyStore` reading the
 * real (local) database, so authentication here is end to end. `RecordStore` is still the stub, so
 * the two 501s below are what a fully-authenticated request looks like today — they are the proof
 * that the key tables work, and they flip to real assertions when records land.
 */

import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { KEY_WRITE, KEY_READER, KEY_REVOKED, KEY_UNKNOWN, seedKeys } from './seed';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const VALID_RECORD = {
  client_id: '3f8a0000-0000-4000-8000-000000000001',
  created_at: '2026-07-15T14:03:22+02:00',
  engine_version: 'engine-1.4.2',
  app_data: { nodes: [['q1', 3]] },
};

const post = (key: string | null, body: unknown) =>
  SELF.fetch('https://example.com/v1/records', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key === null ? {} : { authorization: `Bearer ${key}` }),
    },
    body: JSON.stringify(body),
  });

beforeAll(seedKeys);

describe('worker wiring', () => {
  // `env` arrives now that there is a binding to read; `ctx` still does not, because nothing hands
  // work to `waitUntil`.
  it('404s an unknown path (unit style)', async () => {
    const response = await worker.fetch(new IncomingRequest('https://example.com/'), env);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found', message: 'unknown endpoint' });
  });

  it('404s an unknown path (integration style)', async () => {
    const response = await SELF.fetch('https://example.com/');
    expect(response.status).toBe(404);
  });

  // Reached without touching the database, because routing precedes auth.
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

  it('responds with JSON and a charset', async () => {
    const response = await SELF.fetch('https://example.com/');
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
  });
});

describe('authentication against real D1', () => {
  it('401s an unknown key', async () => {
    expect((await post(KEY_UNKNOWN, { records: [] })).status).toBe(401);
  });

  // Pins the `revoked_at IS NULL` predicate. Dropping it from the query would silently resurrect
  // every key ever revoked, and no other test would fail.
  it('401s a revoked key, indistinguishably from an unknown one', async () => {
    const response = await post(KEY_REVOKED, { records: [] });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthorized', message: 'a valid Bearer key is required' });
  });

  it('403s a read key that tries to write', async () => {
    expect((await post(KEY_READER, { records: [] })).status).toBe(403);
  });

  it('403s a write key that tries to read', async () => {
    const response = await SELF.fetch('https://example.com/v1/records', {
      headers: { authorization: `Bearer ${KEY_WRITE}` },
    });
    expect(response.status).toBe(403);
  });

  // An empty batch is valid and never reaches RecordStore (handlers.ts guards on accepted.length),
  // so this 200 is what proves the key resolved: an unresolved key could not have got here.
  it('200s a valid key sending an empty batch', async () => {
    const response = await post(KEY_WRITE, { records: [] });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ results: [] });
  });
});

describe('storage is still stubbed', () => {
  // The batch must be non-empty: an empty one short-circuits before RecordStore and would return
  // 200, making this assertion prove nothing. This is the test that flips when records land.
  it('501s a write that reaches storage', async () => {
    const response = await post(KEY_WRITE, { records: [VALID_RECORD] });

    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({ error: 'not_implemented' });
  });

  it('501s a read that reaches storage', async () => {
    const response = await SELF.fetch('https://example.com/v1/records', {
      headers: { authorization: `Bearer ${KEY_READER}` },
    });
    expect(response.status).toBe(501);
  });
});
