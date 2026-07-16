import { describe, expect, it } from 'vitest';
import { handleRequest } from '../src/app';
import { MAX_REQUEST_BODY_BYTES } from '../src/config';
import { StorageUnavailableError } from '../src/storage';
import {
  FIXED_RECEIVED_DATE,
  KEY_A,
  KEY_B,
  KEY_C,
  makeDeps,
  postRequest,
  SKEWED_CREATED_AT,
  SKEWED_CREATED_DATE,
  uuid,
  validRecord,
  WRITE_A,
} from './fakes';

interface WriteResponse {
  results: { client_id: string | null; status: string; error?: string; message?: string }[];
}

const post = async (body: unknown, key?: string, init?: RequestInit) => {
  const deps = makeDeps();
  const response = await handleRequest(postRequest(body, key ?? KEY_A, init), deps);
  return { response, deps, body: await response.json<WriteResponse>() };
};

describe('write outcomes', () => {
  it('creates a batch of valid records', async () => {
    const records = [validRecord(), validRecord(), validRecord()];
    const { response, body, deps } = await post({ records });

    expect(response.status).toBe(200);
    expect(body.results.map((r) => r.status)).toEqual(['created', 'created', 'created']);
    expect(deps.recordStore.rows).toHaveLength(3);
  });

  // A duplicate is an acknowledgment, not an error: to a client retrying because it never heard
  // back, "we already have it" is exactly the success it was waiting for.
  it('reports a resent batch as duplicate with status 200', async () => {
    const deps = makeDeps();
    const records = [validRecord(), validRecord()];

    const first = await handleRequest(postRequest({ records }), deps);
    expect(first.status).toBe(200);

    const second = await handleRequest(postRequest({ records }), deps);
    expect(second.status).toBe(200);
    expect((await second.json<WriteResponse>()).results.map((r) => r.status)).toEqual(['duplicate', 'duplicate']);
    expect(deps.recordStore.rows).toHaveLength(2);
  });

  it('allows partial success within one batch', async () => {
    const deps = makeDeps();
    const existing = validRecord();
    await handleRequest(postRequest({ records: [existing] }), deps);

    const response = await handleRequest(
      postRequest({ records: [validRecord(), existing, validRecord({ client_id: 'bad' })] }, KEY_A),
      deps,
    );

    expect(response.status).toBe(200);
    expect((await response.json<WriteResponse>()).results.map((r) => r.status)).toEqual(['created', 'duplicate', 'rejected']);
  });

  it('accepts an empty batch', async () => {
    const { response, body, deps } = await post({ records: [] });
    expect(response.status).toBe(200);
    expect(body.results).toEqual([]);
    expect(deps.recordStore.insertCalls).toBe(0);
  });
});

describe('results alignment', () => {
  it('returns one result per submitted record, in order', async () => {
    const records = [validRecord(), validRecord({ client_id: 'bad' }), validRecord()];
    const { body } = await post({ records });

    expect(body.results).toHaveLength(records.length);
    expect(body.results[0].client_id).toBe(records[0].client_id);
    expect(body.results[2].client_id).toBe(records[2].client_id);
  });

  // The case that makes client_id unusable as a key: a retry-queue merge glitch can legitimately
  // produce the same id twice, and a client keying by it would silently lose an entry.
  it('handles the same client_id twice in one batch', async () => {
    const record = validRecord();
    const { body, deps } = await post({ records: [record, record] });

    expect(body.results.map((r) => r.status)).toEqual(['created', 'duplicate']);
    expect(deps.recordStore.rows).toHaveLength(1);
  });

  it('echoes client_id as null only when the client_id itself was unusable', async () => {
    const { body } = await post({ records: [validRecord({ client_id: 42 })] });
    expect(body.results[0]).toMatchObject({ client_id: null, status: 'rejected' });
  });

  // client_id is validated first precisely so a failure elsewhere still comes back identified.
  it('keys a result whose client_id is valid but whose other fields are not', async () => {
    const record = validRecord({ created_at: 'nonsense' });
    const { body } = await post({ records: [record] });
    expect(body.results[0]).toMatchObject({ client_id: record.client_id, status: 'rejected' });
  });

  it('never echoes back a non-string client_id', async () => {
    const { body } = await post({ records: [validRecord({ client_id: { nested: true } })] });
    expect(body.results[0].client_id).toBeNull();
  });
});

describe('dedupe scope', () => {
  // Dedupe is on (installation, client_id) -- the (app_id, instance_id) pair -- so two
  // installations that happen to mint the same id are storing two genuinely different records.
  // These two tests cover the two axes the pair is made of; both must hold.

  it('does not deduplicate across instances of one app', async () => {
    const deps = makeDeps();
    const record = validRecord();

    const a = await handleRequest(postRequest({ records: [record] }, KEY_A), deps);
    const b = await handleRequest(postRequest({ records: [record] }, KEY_B), deps);

    expect((await a.json<WriteResponse>()).results[0].status).toBe('created');
    expect((await b.json<WriteResponse>()).results[0].status).toBe('created');
    expect(deps.recordStore.rows).toHaveLength(2);
  });

  // The other axis, and the one that is easy to get wrong: KEY_A and KEY_C share an instance and
  // differ only by app. Deduping on instance_id alone would report the second one `duplicate` --
  // which this protocol defines as success, so the client would drop it from its queue and the
  // record would be lost silently. Instances are shared in practice: two apps in one museum, and
  // by default every app sits at `default`.
  it('does not deduplicate across apps at one instance', async () => {
    const deps = makeDeps();
    const record = validRecord();

    const a = await handleRequest(postRequest({ records: [record] }, KEY_A), deps);
    const c = await handleRequest(postRequest({ records: [record] }, KEY_C), deps);

    expect((await a.json<WriteResponse>()).results[0].status).toBe('created');
    expect((await c.json<WriteResponse>()).results[0].status).toBe('created');
    expect(deps.recordStore.rows).toHaveLength(2);
  });
});

describe('stored values', () => {
  it('stamps one received_date for the whole batch', async () => {
    const { deps } = await post({ records: [validRecord(), validRecord()] });

    const stamps = new Set(deps.recordStore.rows.map((row) => row.received_date));
    expect(stamps).toEqual(new Set([FIXED_RECEIVED_DATE]));
  });

  it('stores the local date of created_at, and no time', async () => {
    const { deps } = await post({ records: [validRecord({ created_at: '2026-07-15T14:03:22+02:00' })] });
    expect(deps.recordStore.rows[0].created_date).toBe('2026-07-15');
  });

  // The clock-skew case the two dates exist for, and the one that tells them apart: with a healthy
  // exhibit clock both fall on the same day, so an implementation that wrote the server's date into
  // both -- or swapped them -- would pass every other assertion here.
  it('keeps a wrong exhibit clock visible instead of correcting or dropping it', async () => {
    const { deps } = await post({ records: [validRecord({ created_at: SKEWED_CREATED_AT })] });

    expect(deps.recordStore.rows[0].created_date).toBe(SKEWED_CREATED_DATE);
    expect(deps.recordStore.rows[0].received_date).toBe(FIXED_RECEIVED_DATE);
  });

  it('stores an absent content_version as null', async () => {
    const { deps } = await post({ records: [validRecord()] });
    expect(deps.recordStore.rows[0].content_version).toBeNull();
  });

  it('round-trips app_data unchanged', async () => {
    const app_data = { nodes: [['q1', 3] as const], consent: true, 'ünï©ode': '🎨' };
    const { deps } = await post({ records: [validRecord({ app_data })] });
    expect(deps.recordStore.rows[0].app_data).toEqual(app_data);
  });
});

describe('whole-request failures', () => {
  it('415s a non-JSON content type', async () => {
    const { response } = await post({ records: [] }, KEY_A, { headers: { 'content-type': 'text/plain' } });
    expect(response.status).toBe(415);
  });

  it('accepts a content type with parameters', async () => {
    const { response } = await post({ records: [] }, KEY_A, {
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
    expect(response.status).toBe(200);
  });

  it('400s malformed JSON and a bad envelope', async () => {
    expect((await post('{not json', KEY_A)).response.status).toBe(400);
    expect((await post([], KEY_A)).response.status).toBe(400);
    expect((await post({ records: {} }, KEY_A)).response.status).toBe(400);
    expect((await post({}, KEY_A)).response.status).toBe(400);
  });

  // A client sending 1000 records should split them, not receive 1000 rejections. Checking the
  // count before the per-record loop also stops a huge batch from burning CPU on validation.
  it('400s an over-long batch without validating or storing anything', async () => {
    const records = Array.from({ length: 1000 }, () => validRecord());
    const { response, body, deps } = await post({ records });

    expect(response.status).toBe(400);
    expect(body).toMatchObject({ error: 'batch_too_large' });
    expect(deps.recordStore.insertCalls).toBe(0);
  });

  it('accepts exactly the batch limit', async () => {
    const records = Array.from({ length: 100 }, () => validRecord());
    expect((await post({ records })).response.status).toBe(200);
  });

  it('413s an oversized body', async () => {
    const big = JSON.stringify({ records: [validRecord({ app_data: { a: 'x'.repeat(9 * 1024 * 1024) } })] });
    expect(big.length).toBeGreaterThan(MAX_REQUEST_BODY_BYTES);
    expect((await post(big, KEY_A)).response.status).toBe(413);
  });

  // Content-Length is only a fast path; the streaming counter is what actually enforces the cap.
  it('413s an oversized body whose Content-Length lies about its size', async () => {
    const big = 'x'.repeat(MAX_REQUEST_BODY_BYTES + 1024);
    const { response } = await post(big, KEY_A, { headers: { 'content-length': '10' } });
    expect(response.status).toBe(413);
  });

  it('400s invalid UTF-8 rather than substituting replacement characters', async () => {
    const deps = makeDeps();
    // 0xC3 starts a two-byte sequence that never completes.
    const body = new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xc3, 0x22, 0x7d]);
    const request = new Request('https://example.com/v1/records', {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY_A}`, 'content-type': 'application/json' },
      body,
    });

    const response = await handleRequest(request, deps);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_json' });
  });
});

describe('storage failures', () => {
  // The invariant that keeps the queue protocol honest: `rejected` means "never retry", so a
  // transient failure must never be reported as one, or the client would drop the record for good.
  it('503s a transient storage failure instead of rejecting the records', async () => {
    const deps = makeDeps();
    deps.recordStore.failWith = new StorageUnavailableError();

    const response = await handleRequest(postRequest({ records: [validRecord()] }), deps);

    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBeTruthy();
    expect(await response.json()).toMatchObject({ error: 'unavailable' });
  });

  it('500s an unexpected storage failure without leaking internals', async () => {
    const deps = makeDeps();
    deps.recordStore.failWith = new Error('connection string is postgres://user:hunter2@db');

    const response = await handleRequest(postRequest({ records: [validRecord()] }), deps);
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).not.toContain('hunter2');
    expect(JSON.parse(body)).toEqual({ error: 'internal_error' });
  });
});

describe('validation precedes storage', () => {
  it('never sends a rejected record to the store', async () => {
    const deps = makeDeps();
    const good = validRecord();
    await handleRequest(postRequest({ records: [good, validRecord({ client_id: 'bad' })] }), deps);

    expect(deps.recordStore.rows).toHaveLength(1);
    expect(deps.recordStore.rows[0].client_id).toBe(good.client_id);
  });

  it('does not call the store when every record is rejected', async () => {
    const deps = makeDeps();
    await handleRequest(postRequest({ records: [validRecord({ client_id: 'bad' })] }), deps);
    expect(deps.recordStore.insertCalls).toBe(0);
  });

  it('stores the normalized lowercase client_id', async () => {
    const upper = uuid().toUpperCase();
    const { deps } = await post({ records: [validRecord({ client_id: upper })] });
    expect(deps.recordStore.rows[0].client_id).toBe(upper.toLowerCase());
  });

  // A rejected record gets no log row, deliberately. Logging one would put storage before validation
  // — the ordering this whole handler is built around — and would let anyone holding a key write
  // rows into the log by sending garbage.
  it('never logs a rejected record', async () => {
    const deps = makeDeps();
    const good = validRecord();
    await handleRequest(postRequest({ records: [good, validRecord({ client_id: 'bad' })] }), deps);

    expect(deps.recordStore.submissions).toHaveLength(1);
    expect(deps.recordStore.submissions[0].clientId).toBe(good.client_id);
  });
});

describe('the submission log', () => {
  const cfRequest = (body: unknown) =>
    postRequest(body, KEY_A, {
      headers: { 'cf-connecting-ip': '203.0.113.9', 'user-agent': 'nachbarin-engine/1.4.2' },
    });

  it('logs one row per submitted record, carrying the edge data', async () => {
    const deps = makeDeps();
    await handleRequest(cfRequest({ records: [validRecord(), validRecord()] }), deps);

    expect(deps.recordStore.submissions).toHaveLength(2);
    expect(deps.recordStore.submissions[0]).toMatchObject({
      clientIp: '203.0.113.9',
      userAgent: 'nachbarin-engine/1.4.2',
      keyId: WRITE_A.keyId,
      appId: WRITE_A.appId,
      instanceId: WRITE_A.instanceId,
    });
  });

  // The grain, at the handler level: the client is told `duplicate` and the log still gains a row.
  // That row is the only evidence the resubmission ever happened.
  it('logs a duplicate resend even though no record is stored', async () => {
    const deps = makeDeps();
    const one = validRecord();

    await handleRequest(postRequest({ records: [one] }), deps);
    const second = await handleRequest(postRequest({ records: [one] }), deps);

    expect((await second.json<WriteResponse>()).results[0].status).toBe('duplicate');
    expect(deps.recordStore.rows).toHaveLength(1);
    expect(deps.recordStore.submissions).toHaveLength(2);
  });

  it('shares one submission id across a batch and mints a new one per request', async () => {
    const deps = makeDeps();
    await handleRequest(postRequest({ records: [validRecord(), validRecord()] }), deps);
    await handleRequest(postRequest({ records: [validRecord()] }), deps);

    const [a, b, c] = deps.recordStore.submissions;
    expect(a.submissionId).toBe(b.submissionId);
    expect(c.submissionId).not.toBe(a.submissionId);
  });

  // The precision `records` throws away, which is this table's entire reason to exist. The offset
  // must survive: a store that normalized to UTC would still look right in every other assertion.
  it('logs created_at verbatim while the record keeps only its date', async () => {
    const deps = makeDeps();
    await handleRequest(postRequest({ records: [validRecord({ created_at: SKEWED_CREATED_AT })] }), deps);

    expect(deps.recordStore.submissions[0].createdAt).toBe(SKEWED_CREATED_AT);
    expect(deps.recordStore.rows[0].created_date).toBe(SKEWED_CREATED_DATE);
  });

  // No `cf` and no Cloudflare headers — the default under test, and never an error.
  it('logs nulls rather than failing when the edge told us nothing', async () => {
    const { deps, response } = await post({ records: [validRecord()] });

    expect(response.status).toBe(200);
    expect(deps.recordStore.submissions[0]).toMatchObject({ clientIp: null, country: null, asn: null });
  });
});
