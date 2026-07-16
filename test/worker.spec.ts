/**
 * Exercises the real `src/index.ts` wiring through the Workers runtime.
 *
 * Unlike the handler specs, these inject nothing: both stores are the real D1 adapters reading the
 * real (local) database. Authentication, storage and scope are all end to end here, which is what
 * the fakes cannot prove.
 */

import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import worker from '../src/index';
import type { StoredRecord } from '../src/storage';
import { KEY_WRITE, KEY_READER, KEY_READER_SAME, KEY_REVOKED, KEY_UNKNOWN, SEEDED_APP, SEEDED_INSTANCE, seedKeys } from './seed';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

interface ReadResponse {
  records: StoredRecord[];
  next_after_id: number;
  has_more: boolean;
}

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

const read = (key: string, query = '') =>
  SELF.fetch(`https://example.com/v1/records${query}`, { headers: { authorization: `Bearer ${key}` } });

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
    expect((await read(KEY_WRITE)).status).toBe(403);
  });

  // An empty batch is valid and never reaches RecordStore (handlers.ts guards on accepted.length),
  // so this 200 is what proves the key resolved: an unresolved key could not have got here.
  it('200s a valid key sending an empty batch', async () => {
    const response = await post(KEY_WRITE, { records: [] });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ results: [] });
  });
});

describe('storage against real D1', () => {
  // The whole protocol in one test, through the real Worker and the real database: a batch is
  // written, comes back `created`, and is then downloaded by a reader on that installation.
  it('round-trips a batch from write key to read key', async () => {
    expect((await post(KEY_WRITE, { records: [VALID_RECORD] })).status).toBe(200);

    const response = await read(KEY_READER_SAME);
    const body = await response.json<ReadResponse>();

    expect(response.status).toBe(200);
    expect(body.has_more).toBe(false);
    expect(body.records).toHaveLength(1);
    expect(body.records[0]).toMatchObject({
      app_id: SEEDED_APP,
      instance_id: SEEDED_INSTANCE,
      client_id: VALID_RECORD.client_id,
      created_date: '2026-07-15',
      app_data: { nodes: [['q1', 3]] },
    });
    expect(body.next_after_id).toBe(body.records[0].id);
  });

  // Retrying a batch is the normal case, not the exceptional one: a client that never heard our
  // response sends it again. It must be told we have it, and must not store it twice.
  it('reports a resent batch as duplicate without storing it twice', async () => {
    await post(KEY_WRITE, { records: [VALID_RECORD] });
    const again = await post(KEY_WRITE, { records: [VALID_RECORD] });

    expect(await again.json()).toEqual({ results: [{ client_id: VALID_RECORD.client_id, status: 'duplicate' }] });
    expect((await (await read(KEY_READER_SAME)).json<ReadResponse>()).records).toHaveLength(1);
  });

  // The scope, end to end. KEY_READER is a valid read key on the *other* installation, so it must
  // see nothing of what KEY_WRITE just deposited -- there is no parameter it could add to change
  // that, which is the point of scope being authorization rather than a filter.
  it('shows one installation nothing of another', async () => {
    await post(KEY_WRITE, { records: [VALID_RECORD] });

    const body = await (await read(KEY_READER)).json<ReadResponse>();

    expect(body.records).toEqual([]);
    expect(body.has_more).toBe(false);
    // Echoes the cursor back rather than special-casing an empty page.
    expect(body.next_after_id).toBe(0);
  });
});

describe('the submission log, end to end', () => {
  // The only place the real `request.cf` reaches the real adapter. `SELF.fetch` cannot carry a `cf`,
  // so this goes through `worker.fetch` directly -- which is exactly what `IncomingRequest` is for.
  //
  // `crypto.randomUUID` is live here rather than the fakes' counter, so this also proves the id the
  // real wiring mints satisfies the schema's UUID CHECK.
  it('writes the full timestamps and the edge data that GET refuses to show', async () => {
    const request = new IncomingRequest('https://example.com/v1/records', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${KEY_WRITE}`,
        'cf-connecting-ip': '203.0.113.9',
        'user-agent': 'nachbarin-engine/1.4.2',
      },
      body: JSON.stringify({ records: [VALID_RECORD] }),
      // Cast because the type insists on every field (httpProtocol, tlsVersion, …) while a real
      // request carries whatever the edge resolved and no more. A partial `cf` is the honest fixture
      // here — it is the shape `provenance.ts` exists to cope with.
      cf: {
        country: 'DE',
        city: 'Munich',
        asn: 3320,
        asOrganization: 'Deutsche Telekom AG',
        colo: 'FRA',
        timezone: 'Europe/Berlin',
      } as IncomingRequestCfProperties,
    });

    const response = await worker.fetch(request, env);
    expect(response.status).toBe(200);

    const row = await env.DB.prepare('SELECT * FROM record_submissions').first<Record<string, unknown>>();
    expect(row).toMatchObject({
      // Verbatim, offset intact -- the fact `records` is built to discard and this table to keep.
      created_at: VALID_RECORD.created_at,
      client_id: VALID_RECORD.client_id,
      client_ip: '203.0.113.9',
      user_agent: 'nachbarin-engine/1.4.2',
      cf_country: 'DE',
      cf_city: 'Munich',
      cf_asn: 3320,
      cf_colo: 'FRA',
      cf_timezone: 'Europe/Berlin',
    });

    // The two tables disagree on purpose, and this is the pair that proves it: the log has the
    // clock, and nothing the read API returns does.
    const body = await (await read(KEY_READER_SAME)).json<ReadResponse>();
    expect(JSON.stringify(body.records)).not.toMatch(/\d{2}:\d{2}/);
  });

  it('sweeps expired rows on the scheduled handler', async () => {
    await post(KEY_WRITE, { records: [VALID_RECORD] });
    // Age it past the window rather than waiting 90 days.
    await env.DB.prepare(`UPDATE record_submissions SET received_at = '2020-01-01T00:00:00.000Z'`).run();

    // Two arguments, not three: `scheduled` awaits its own work, so it takes no `ctx` — the same
    // reason `fetch` does not.
    await worker.scheduled({ scheduledTime: Date.now(), cron: '17 3 * * *', noRetry: () => undefined }, env);

    const { results } = await env.DB.prepare('SELECT id FROM record_submissions').all();
    expect(results).toHaveLength(0);

    // And the record it described is untouched -- still downloadable, still dateless.
    const body = await (await read(KEY_READER_SAME)).json<ReadResponse>();
    expect(body.records).toHaveLength(1);
  });
});
