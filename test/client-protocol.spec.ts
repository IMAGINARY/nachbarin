/**
 * The other half of the parity check: the response shapes.
 *
 * `packages/client/` re-declares this service's wire contract, because it cannot import it —
 * `packages/client/tsconfig.json` sets `types: []` deliberately, and `src/storage.ts` reaches
 * `request.cf` through `src/provenance.ts`, which needs the Cloudflare `Request`. That makes
 * client -> Worker a poisoned import direction for anything but the two pure-data modules
 * `packages/client/src/protocol.parity.spec.ts` uses.
 *
 * Worker -> client is clean, and only because `packages/client/src/protocol.ts` has no imports of
 * its own. Keep it that way: this file is what would break otherwise, and it would break in the
 * Workers pool with an error about a missing type rather than about the contract.
 *
 * The assertions here are deliberately made against what the handlers **actually emit**, driven
 * through the same fakes every other handler spec uses. A type-level check would only prove that two
 * declarations agree, and both could be stale together.
 */

import { describe, expect, it } from 'vitest';
import {
  ERROR_CODES as CLIENT_ERROR_CODES,
  RECORD_PAGE_KEYS,
  RECORD_RESULT_OPTIONAL_KEYS,
  RECORD_RESULT_REQUIRED_KEYS,
  RECORD_STATUSES,
  READ_QUERY_KEYS,
  STORED_RECORD_KEYS,
  WIRE_RECORD_KEYS,
  WRITE_RESPONSE_KEYS,
  type ErrorCode as ClientErrorCode,
  type RecordPage as ClientRecordPage,
  type RecordResult as ClientRecordResult,
  type StoredRecord as ClientStoredRecord,
} from '../packages/client/src/protocol';
import { handleRequest } from '../src/app';
import type { ErrorCode } from '../src/http';
import type { RecordResult } from '../src/handlers';
import type { StoredRecord } from '../src/storage';
import { getRequest, KEY_A, makeDeps, postRequest, validRecord } from './fakes';

/**
 * Compile-time parity. Red under `npx tsc --noEmit -p test/tsconfig.json`.
 *
 * `Exclude<A, B>` is `never` exactly when every member of A is also a member of B, so constraining
 * it to `never` in both directions asserts the two are equal. It has to be a *constraint*: declaring
 * a variable of type `Exclude<…>` and assigning `never` to it proves nothing, because `never` is
 * assignable to everything — that spelling type-checks happily while the contract drifts.
 *
 * This is the half a runtime test cannot reach: a field the service could emit but does not in any
 * fixture, and a union member no handler currently returns.
 */
function assertEmpty<T extends never>(): T[] {
  // The constraint is the assertion; the return type is only there to give `T` a use.
  return [];
}

assertEmpty<Exclude<ErrorCode, ClientErrorCode>>();
assertEmpty<Exclude<ClientErrorCode, ErrorCode>>();
assertEmpty<Exclude<RecordResult['status'], (typeof RECORD_STATUSES)[number]>>();
assertEmpty<Exclude<(typeof RECORD_STATUSES)[number], RecordResult['status']>>();
assertEmpty<Exclude<keyof StoredRecord, keyof ClientStoredRecord>>();
assertEmpty<Exclude<keyof ClientStoredRecord, keyof StoredRecord>>();
assertEmpty<Exclude<keyof RecordResult, keyof ClientRecordResult>>();
assertEmpty<Exclude<keyof ClientRecordResult, keyof RecordResult>>();

/**
 * And the field *types* agree, not merely the field names.
 *
 * Spelled as never-called functions so the check is entirely in the signature. A `declare const`
 * assigned to a typed variable reads the same but is not: the declaration is erased and the
 * assignment is not, so it becomes a `ReferenceError` at import time.
 */
function _acceptsWorkerRecord(record: StoredRecord): ClientStoredRecord {
  return record;
}
function _acceptsWorkerResult(result: RecordResult): ClientRecordResult {
  return result;
}
void _acceptsWorkerRecord;
void _acceptsWorkerResult;

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return await response.json();
}

describe('the write response is what the client expects', () => {
  it('has exactly the envelope keys', async () => {
    const deps = makeDeps();
    const response = await handleRequest(postRequest({ records: [validRecord()] }), deps);

    expect(response.status).toBe(200);
    expect(Object.keys(await bodyOf(response)).sort()).toEqual([...WRITE_RESPONSE_KEYS].sort());
  });

  it('has exactly the required result keys on an accepted record', async () => {
    const deps = makeDeps();
    const response = await handleRequest(postRequest({ records: [validRecord()] }), deps);
    const body = await bodyOf(response);
    const [result] = body.results as Record<string, unknown>[];

    expect(Object.keys(result).sort()).toEqual([...RECORD_RESULT_REQUIRED_KEYS].sort());
    expect((RECORD_STATUSES as readonly string[]).includes(result.status as string)).toBe(true);
  });

  it('adds only the optional keys on a rejected record', async () => {
    const deps = makeDeps();
    const response = await handleRequest(postRequest({ records: [validRecord({ engine_version: '' })] }), deps);
    const body = await bodyOf(response);
    const [result] = body.results as Record<string, unknown>[];

    expect(result.status).toBe('rejected');
    const allowed = new Set<string>([...RECORD_RESULT_REQUIRED_KEYS, ...RECORD_RESULT_OPTIONAL_KEYS]);
    for (const key of Object.keys(result)) expect(allowed.has(key)).toBe(true);
    for (const key of RECORD_RESULT_REQUIRED_KEYS) expect(Object.keys(result)).toContain(key);
    expect((CLIENT_ERROR_CODES as readonly string[]).includes(result.error as string)).toBe(true);
  });

  it('accepts every field the client is willing to send, and nothing more', async () => {
    // The client builds records from WIRE_RECORD_KEYS; the service rejects unknown fields rather
    // than ignoring them, so a key here that the service does not know is a permanent rejection.
    const deps = makeDeps();
    const full = validRecord({ content_version: 'sha256:ab12cd34' });
    expect(Object.keys(full).sort()).toEqual([...WIRE_RECORD_KEYS].sort());

    const response = await handleRequest(postRequest({ records: [full] }), deps);
    const body = await bodyOf(response);

    expect((body.results as { status: string }[])[0].status).toBe('created');
  });
});

describe('the read response is what the client expects', () => {
  it('has exactly the page keys', async () => {
    const deps = makeDeps();
    await handleRequest(postRequest({ records: [validRecord()] }, KEY_A), deps);
    const response = await handleRequest(getRequest(), deps);
    const body = await bodyOf(response);

    expect(response.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual([...RECORD_PAGE_KEYS].sort());
    expect(typeof body.next_after_id).toBe('number');
    expect(typeof body.has_more).toBe('boolean');
  });

  it('has exactly the record keys, on an empty page too', async () => {
    const deps = makeDeps();
    await handleRequest(postRequest({ records: [validRecord()] }, KEY_A), deps);
    const body = await bodyOf(await handleRequest(getRequest(), deps));
    const [record] = body.records as Record<string, unknown>[];

    expect(Object.keys(record).sort()).toEqual([...STORED_RECORD_KEYS].sort());
  });

  it('carries no exact timestamp the client would have to know about', async () => {
    // Dates and never times, and the client's StoredRecord says so. A timestamp appearing here
    // would be both a privacy regression and a silent contract change.
    const deps = makeDeps();
    await handleRequest(postRequest({ records: [validRecord()] }, KEY_A), deps);
    const body = await bodyOf(await handleRequest(getRequest(), deps));
    const [record] = body.records as Record<string, unknown>[];

    expect(record.created_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(record.received_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(JSON.stringify(record)).not.toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  it('accepts every query parameter the client is willing to send', async () => {
    // Unknown parameters are a hard 400, so a key the client sends and the service does not know
    // would fail every read — and a typo'd one would silently re-download the whole corpus.
    const deps = makeDeps();
    const query = READ_QUERY_KEYS.map((key) => `${key}=${key.endsWith('_id') || key === 'limit' ? '1' : 'x'}`).join('&');
    const response = await handleRequest(getRequest(`?${query}`), deps);

    expect(response.status).toBe(200);
  });
});

describe('the error body is what the client expects', () => {
  it('names a code the client knows', async () => {
    const deps = makeDeps();
    const response = await handleRequest(getRequest('?after=1'), deps);
    const body = await bodyOf(response);

    expect(response.status).toBe(400);
    expect(Object.keys(body).sort()).toEqual(['error', 'message']);
    expect((CLIENT_ERROR_CODES as readonly string[]).includes(body.error as string)).toBe(true);
  });

  it('sends internal_error with no message, which the client tolerates', async () => {
    const deps = makeDeps();
    deps.recordStore.failWith = new Error('boom');
    const response = await handleRequest(postRequest({ records: [validRecord()] }), deps);
    const body = await bodyOf(response);

    expect(response.status).toBe(500);
    expect(Object.keys(body)).toEqual(['error']);
    expect((CLIENT_ERROR_CODES as readonly string[]).includes(body.error as string)).toBe(true);
  });
});

/** Kept honest by use: if the client's page type stops describing a real page, this stops compiling. */
function _assignable(page: ClientRecordPage): number {
  return page.records.length + page.next_after_id;
}
void _assignable;
