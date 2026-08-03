/**
 * Half of the parity check: the numbers and the vocabulary.
 *
 * This package re-declares the service's contract because it cannot import it — `tsconfig.json` sets
 * `types: []` on purpose, and the Worker's `src/storage.ts` reaches `request.cf` through
 * `src/provenance.ts`, which needs the Cloudflare `Request`. Type-importing it would drag
 * `worker-configuration.d.ts` into a program built to prove this code needs none of it.
 *
 * So the copies are pinned against each other by tests instead, and the direction of the import is
 * what decides which test lives where:
 *
 * - **Here**, client -> Worker, and only into modules that have **no imports and name no ambient
 *   global**. `config.ts` and `error-codes.ts` qualify, which is the whole reason the second one was
 *   split out of `http.ts`. Adding an import to either breaks this spec — that is the intended
 *   alarm, not an accident.
 * - **`test/client-protocol.spec.ts`**, Worker -> client, for the response *shapes*. That direction
 *   is clean because `protocol.ts` depends on nothing, and it can assert against what the handlers
 *   actually emit rather than against a type declaration that could itself be stale.
 *
 * Both are runtime assertions on purpose. A type-level check would be a red typecheck rather than a
 * red test, and `npx vitest run` would stay green while the contract drifted.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_APP_DATA_BYTES as WORKER_MAX_APP_DATA_BYTES,
  MAX_RECORDS_PER_BATCH as WORKER_MAX_RECORDS_PER_BATCH,
  MAX_REQUEST_BODY_BYTES as WORKER_MAX_REQUEST_BODY_BYTES,
  MAX_VERSION_LENGTH as WORKER_MAX_VERSION_LENGTH,
  READ_LIMIT_DEFAULT as WORKER_READ_LIMIT_DEFAULT,
  READ_LIMIT_MAX as WORKER_READ_LIMIT_MAX,
} from '../../../src/config';
import { ERROR_CODES as WORKER_ERROR_CODES } from '../../../src/error-codes';
import {
  ERROR_CODES,
  MAX_APP_DATA_BYTES,
  MAX_RECORDS_PER_BATCH,
  MAX_REQUEST_BODY_BYTES,
  MAX_VERSION_LENGTH,
  READ_LIMIT_DEFAULT,
  READ_LIMIT_MAX,
} from './protocol';

describe('limits match the Worker', () => {
  it.each([
    ['MAX_RECORDS_PER_BATCH', MAX_RECORDS_PER_BATCH, WORKER_MAX_RECORDS_PER_BATCH],
    ['MAX_APP_DATA_BYTES', MAX_APP_DATA_BYTES, WORKER_MAX_APP_DATA_BYTES],
    ['MAX_REQUEST_BODY_BYTES', MAX_REQUEST_BODY_BYTES, WORKER_MAX_REQUEST_BODY_BYTES],
    ['MAX_VERSION_LENGTH', MAX_VERSION_LENGTH, WORKER_MAX_VERSION_LENGTH],
    ['READ_LIMIT_DEFAULT', READ_LIMIT_DEFAULT, WORKER_READ_LIMIT_DEFAULT],
    ['READ_LIMIT_MAX', READ_LIMIT_MAX, WORKER_READ_LIMIT_MAX],
  ])('%s', (_name, client, worker) => {
    expect(client).toBe(worker);
  });
});

describe('the error vocabulary matches the Worker', () => {
  it('has the same codes', () => {
    // Sorted, because the order is not contractual and a reordering is not drift.
    expect([...ERROR_CODES].sort()).toEqual([...WORKER_ERROR_CODES].sort());
  });

  it('has no duplicates on either side', () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
    expect(new Set(WORKER_ERROR_CODES).size).toBe(WORKER_ERROR_CODES.length);
  });
});
