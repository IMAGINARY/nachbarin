import { describe, expect, it } from 'vitest';
import { handleRequest } from '../src/app';
import { MAX_REQUEST_BODY_BYTES } from '../src/config';
import { getRequest, KEY_A, KEY_B, KEY_READ, makeDeps, postRequest, validRecord } from './fakes';

describe('authentication', () => {
  it('401s a missing or malformed Authorization header, and advertises the scheme', async () => {
    const headers = [null, 'Basic abc', 'Bearer', 'Bearer ', 'Token abc', 'bearerabc'];
    for (const header of headers) {
      const request = new Request('https://example.com/v1/records', {
        method: 'GET',
        headers: header === null ? {} : { authorization: header },
      });
      const response = await handleRequest(request, makeDeps());
      expect(response.status, String(header)).toBe(401);
      expect(response.headers.get('www-authenticate'), String(header)).toBe('Bearer');
    }
  });

  it('accepts a lowercase scheme, which RFC 9110 makes case-insensitive', async () => {
    const request = new Request('https://example.com/v1/records', {
      method: 'GET',
      headers: { authorization: `bearer ${KEY_READ}` },
    });
    expect((await handleRequest(request, makeDeps())).status).toBe(200);
  });

  it('401s an unknown key', async () => {
    const response = await handleRequest(getRequest('', 'no-such-key'), makeDeps());
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: 'unauthorized' });
  });

  // A revoked key resolves to null exactly like an unknown one; the response must not reveal that
  // the key ever existed.
  it('makes a revoked key indistinguishable from an unknown one', async () => {
    const deps = makeDeps();
    const revoked = await handleRequest(getRequest('', 'revoked-key'), deps);
    const unknown = await handleRequest(getRequest('', 'never-existed'), deps);
    expect(revoked.status).toBe(unknown.status);
    expect(await revoked.json()).toEqual(await unknown.json());
  });
});

describe('authorization', () => {
  // The whole point of separate key kinds: a write key can never read.
  it('403s a write key on the read endpoint', async () => {
    const response = await handleRequest(getRequest('', KEY_A), makeDeps());
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'forbidden' });
  });

  it('403s the read key on the write endpoint', async () => {
    const response = await handleRequest(postRequest({ records: [] }, KEY_READ), makeDeps());
    expect(response.status).toBe(403);
  });

  // 401 means "I don't know who you are"; 403 means "I know, and you may not do this".
  it('distinguishes an unknown key from a known key used wrongly', async () => {
    const deps = makeDeps();
    expect((await handleRequest(getRequest('', 'bogus'), deps)).status).toBe(401);
    expect((await handleRequest(getRequest('', KEY_A), deps)).status).toBe(403);
  });
});

describe('identity comes from the key', () => {
  it('derives different installations from different keys', async () => {
    const deps = makeDeps();
    await handleRequest(postRequest({ records: [validRecord()] }, KEY_A), deps);
    await handleRequest(postRequest({ records: [validRecord()] }, KEY_B), deps);

    expect(deps.recordStore.rows.map((row) => row.instance_id)).toEqual(['instance-a', 'instance-b']);
  });

  it('refuses a body that tries to declare its own identity', async () => {
    const deps = makeDeps();
    const response = await handleRequest(postRequest({ records: [validRecord({ instance_id: 'instance-b' })] }, KEY_A), deps);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ results: [{ status: 'rejected', error: 'invalid_field' }] });
    expect(deps.recordStore.rows).toHaveLength(0);
  });
});

describe('ordering', () => {
  // Authenticating before reading the body is what stops an anonymous caller from making us
  // buffer megabytes for free.
  it('401s an unauthenticated oversized body without reading it', async () => {
    const deps = makeDeps();
    const request = new Request('https://example.com/v1/records', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(MAX_REQUEST_BODY_BYTES * 2) },
      body: 'x'.repeat(1024),
    });

    const response = await handleRequest(request, deps);
    expect(response.status).toBe(401);
    expect(deps.recordStore.insertCalls).toBe(0);
  });

  it('authenticates before checking the media type', async () => {
    const request = new Request('https://example.com/v1/records', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'nope',
    });
    expect((await handleRequest(request, makeDeps())).status).toBe(401);
  });
});
