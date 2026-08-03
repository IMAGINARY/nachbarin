/**
 * What a request writes to Workers Logs.
 *
 * Two things are being pinned, and the second is the reason this file exists.
 *
 * The first is shape: one line per request, the fields that make a 200 legible, and the level. That
 * is ordinary regression cover.
 *
 * The second is the never-log rule from `src/observability.ts`. `records.post.spec.ts` already
 * asserts that a leaked secret does not reach the *response*, but a log line is the other direction
 * the same data can escape, and nothing was watching it. The leak tests below use sentinels planted
 * in the places a payload actually lives — inside `app_data`, as a `client_id`, as the bearer key —
 * and search the serialized lines for them, rather than asserting on a list of field names. A list
 * of names would pass while a future field carried the value under a different one.
 */

import { describe, expect, it } from 'vitest';
import { handleRequest } from '../src/app';
import { MAX_RESPONSE_BYTES } from '../src/config';
import { StorageUnavailableError } from '../src/storage';
import type { StoredRecord } from '../src/storage';
import {
  FIXED_RECEIVED_DATE,
  getRequest,
  KEY_A,
  KEY_READ,
  makeDeps,
  postRequest,
  recordWithout,
  type TestDeps,
  uuid,
  validRecord,
} from './fakes';

/** Everything the logger saw, as one string — the only honest way to ask "does X appear anywhere". */
const emitted = (deps: TestDeps) => JSON.stringify(deps.log.lines);

function row(id: number, overrides: Partial<StoredRecord> = {}): StoredRecord {
  return {
    id,
    app_id: 'app-1',
    instance_id: 'instance-a',
    client_id: `3f8a0000-0000-4000-8000-${id.toString(16).padStart(12, '0')}`,
    created_date: '2026-07-15',
    received_date: FIXED_RECEIVED_DATE,
    engine_version: 'engine-1.4.2',
    content_version: 'sha256:ab12',
    app_data: { nodes: [['q1', 3]] },
    ...overrides,
  };
}

describe('one line per request', () => {
  // The regression the next code path introduces. A shape assertion passes just as happily against
  // two lines as one, and doubling the events per request is what puts the free plan's 200k/day
  // budget under the 100k/day request ceiling.
  it('emits exactly one line, whatever the outcome', async () => {
    for (const request of [
      postRequest({ records: [validRecord()] }),
      getRequest('', KEY_READ),
      postRequest({ records: [] }, null),
      new Request('https://example.com/nope'),
      new Request('https://example.com/v1/records', { method: 'DELETE' }),
      postRequest('not json'),
    ]) {
      const deps = makeDeps();
      await handleRequest(request, deps);
      expect(deps.log.lines).toHaveLength(1);
    }
  });

  // The level splits on 5xx and nothing finer: a 4xx is the protocol working, a 5xx is ours to
  // answer for. A 503 counts — it is retryable for the *client*, but it still means storage failed.
  it('logs 5xx at error level and everything else at info', async () => {
    const boom = makeDeps();
    boom.recordStore.failWith = new Error('nope');
    await handleRequest(postRequest({ records: [validRecord()] }), boom);
    expect(boom.log.only().level).toBe('error');

    const busy = makeDeps();
    busy.recordStore.failWith = new StorageUnavailableError();
    await handleRequest(postRequest({ records: [validRecord()] }), busy);
    expect(busy.log.only().level).toBe('error');

    const rejected = makeDeps();
    await handleRequest(getRequest('?limit=nope', KEY_READ), rejected);
    expect(rejected.log.only().level).toBe('info');

    const ok = makeDeps();
    await handleRequest(getRequest('', KEY_READ), ok);
    expect(ok.log.only().level).toBe('info');
  });
});

describe('write lines', () => {
  it('counts the outcomes that a 200 otherwise hides', async () => {
    const deps = makeDeps();
    const repeated = validRecord();
    await handleRequest(postRequest({ records: [repeated] }), deps);
    deps.log.lines.length = 0;

    const response = await handleRequest(postRequest({ records: [validRecord(), repeated, recordWithout('created_at')] }), deps);

    expect(response.status).toBe(200);
    expect(deps.log.only().fields).toMatchObject({
      event: 'request',
      method: 'POST',
      status: 200,
      app_id: 'app-1',
      instance_id: 'instance-a',
      key_id: 11,
      key_kind: 'write',
      created: 1,
      duplicate: 1,
      rejected: 1,
      rejections: { invalid_field: 1 },
    });
  });

  it('carries the submission id that joins the line to record_submissions', async () => {
    const deps = makeDeps();
    await handleRequest(postRequest({ records: [validRecord()] }), deps);

    expect(deps.log.only().fields.submission_id).toBe(deps.recordStore.submissions[0].submissionId);
  });

  // Absent rather than null, and worth pinning: an operator filtering on it is filtering out the
  // batches that stored nothing, which is exactly when a client is misbehaving.
  it('omits the submission id when the batch stored nothing', async () => {
    const deps = makeDeps();
    await handleRequest(postRequest({ records: [recordWithout('app_data')] }), deps);

    const { fields } = deps.log.only();
    expect(fields).not.toHaveProperty('submission_id');
    expect(fields).toMatchObject({ created: 0, duplicate: 0, rejected: 1 });
  });

  it('omits the rejection histogram when nothing was rejected', async () => {
    const deps = makeDeps();
    await handleRequest(postRequest({ records: [validRecord()] }), deps);

    expect(deps.log.only().fields).not.toHaveProperty('rejections');
  });
});

describe('read lines', () => {
  it('reports what the reader got back', async () => {
    const deps = makeDeps();
    for (let id = 1; id <= 5; id++) deps.recordStore.rows.push(row(id));

    await handleRequest(getRequest('?limit=2', KEY_READ), deps);

    expect(deps.log.only().fields).toMatchObject({
      event: 'request',
      method: 'GET',
      status: 200,
      key_kind: 'read',
      returned: 2,
      has_more: true,
      truncated: false,
    });
  });

  // The byte budget is invisible on the wire by design — a truncated page is indistinguishable from
  // any other short page — so this line is the only place the fact is recorded anywhere.
  it('reports a page truncated by the byte budget', async () => {
    const deps = makeDeps();
    // Two of these overflow the budget, so the page stops after the first — and `has_more` flips to
    // true even though the store had said there was nothing beyond the four asked for.
    const big = 'x'.repeat(MAX_RESPONSE_BYTES / 2);
    for (let id = 1; id <= 4; id++) deps.recordStore.rows.push(row(id, { app_data: big }));

    await handleRequest(getRequest('?limit=4', KEY_READ), deps);

    expect(deps.log.only().fields).toMatchObject({ returned: 1, has_more: true, truncated: true });
  });
});

describe('failure lines', () => {
  it('records the error code behind every status the client sees', async () => {
    const cases: [Request, number, string][] = [
      [new Request('https://example.com/nope'), 404, 'not_found'],
      [new Request('https://example.com/v1/records', { method: 'DELETE' }), 405, 'method_not_allowed'],
      [postRequest({ records: [] }, null), 401, 'unauthorized'],
      [getRequest('', KEY_A), 403, 'forbidden'],
      [postRequest('not json'), 400, 'invalid_json'],
      [postRequest({ records: [validRecord()] }, KEY_A, { headers: { 'content-type': 'text/plain' } }), 415, 'unsupported_media_type'],
      [getRequest('?limit=nope', KEY_READ), 400, 'invalid_request'],
    ];

    for (const [request, status, error] of cases) {
      const deps = makeDeps();
      const response = await handleRequest(request, deps);

      expect(response.status).toBe(status);
      // The point of routing every failure through `fail`: the log cannot disagree with the body.
      expect(await response.json()).toMatchObject({ error });
      expect(deps.log.only().fields).toMatchObject({ status, error });
    }
  });

  it('describes an unhandled error, which is the only place its detail is allowed to go', async () => {
    const deps = makeDeps();
    deps.recordStore.failWith = new TypeError('d1 exploded');

    await handleRequest(postRequest({ records: [validRecord()] }), deps);

    expect(deps.log.only().fields).toMatchObject({
      status: 500,
      error: 'internal_error',
      error_name: 'TypeError',
      error_message: 'd1 exploded',
    });
    expect(deps.log.only().fields.stack).toContain('d1 exploded');
  });

  // `StorageUnavailableError`'s message is a constant, so the name is the only thing that says which
  // store gave up. The 503 branch logged nothing at all before.
  it('names the failure behind a 503', async () => {
    const deps = makeDeps();
    deps.recordStore.failWith = new StorageUnavailableError();

    await handleRequest(postRequest({ records: [validRecord()] }), deps);

    expect(deps.log.only().fields).toMatchObject({ status: 503, error: 'unavailable', error_name: 'StorageUnavailableError' });
  });
});

describe('never logged', () => {
  it('keeps the submitted payload out of the line', async () => {
    const deps = makeDeps();
    const clientId = uuid();
    const record = validRecord({ client_id: clientId, app_data: { answer: 'CANARY-VISITOR-CHOICE' } });

    await handleRequest(postRequest({ records: [record] }), deps);

    const lines = emitted(deps);
    expect(lines).not.toContain('CANARY-VISITOR-CHOICE');
    expect(lines).not.toContain(clientId);
    expect(lines).not.toContain(KEY_A);
  });

  it('keeps stored payloads out of a read line', async () => {
    const deps = makeDeps();
    deps.recordStore.rows.push(row(1, { app_data: { answer: 'CANARY-STORED-CHOICE' } }));

    await handleRequest(getRequest('', KEY_READ), deps);

    const lines = emitted(deps);
    expect(lines).not.toContain('CANARY-STORED-CHOICE');
    expect(lines).not.toContain(row(1).client_id);
    expect(lines).not.toContain(KEY_READ);
  });

  // The subtlest path in: a malformed body reaches `JSON.parse`, whose error quotes the first ~10
  // characters of its input verbatim. `handlers.ts` drops that error for exactly this reason.
  it('does not echo a malformed body through the parse error', async () => {
    const deps = makeDeps();

    await handleRequest(postRequest('CANARY-MALFORMED-BODY'), deps);

    expect(emitted(deps)).not.toContain('CANARY-MALFORMED');
  });

  // Three validation messages interpolate client-supplied field and parameter names, so the code is
  // logged and the prose is not — even though the client is shown both.
  it('logs the error code without the message that quotes the client', async () => {
    const deps = makeDeps();

    const response = await handleRequest(getRequest('?canary_param=1', KEY_READ), deps);

    expect(await response.text()).toContain('canary_param');
    expect(deps.log.only().fields).toMatchObject({ error: 'invalid_request' });
    expect(emitted(deps)).not.toContain('canary_param');
  });

  // No IP, user agent, city, ASN or timezone: those live in `record_submissions`, which no key can
  // read and which expires. A log line has neither property, so it gets the submission id and no more.
  it('carries no edge provenance beyond the submission id', async () => {
    const deps = makeDeps();
    const request = postRequest({ records: [validRecord()] }, KEY_A, {
      headers: { 'cf-connecting-ip': '203.0.113.7', 'user-agent': 'CanaryKiosk/1.0' },
    });

    await handleRequest(request, deps);

    const lines = emitted(deps);
    expect(lines).not.toContain('203.0.113.7');
    expect(lines).not.toContain('CanaryKiosk');
  });
});
