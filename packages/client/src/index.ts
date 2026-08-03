/**
 * Public entry point for the nachbarin client.
 *
 * Re-exports only — every declaration lives in the module that owns it, and this file is the list of
 * what a consumer may depend on. Anything not named here is internal and free to change.
 *
 * Two factories rather than one client, because a key is either `read` or `write` and never both.
 * An object carrying both methods would always have a half that can only 403; making the wrong call
 * unwritable is better than making it a runtime error.
 *
 * Note what is *not* re-exported: the `*_KEYS` arrays from `protocol.ts`. They exist for the parity
 * specs, and naming them here would keep them in every consumer's bundle for nothing.
 */

export { createWriteClient } from './write-client';
export type {
  DiagnosticEvent,
  FlushResult,
  NewRecordInput,
  RecordOutcome,
  WriteClient,
  WriteClientOptions,
  WriteClientState,
} from './write-client';

export { createReadClient } from './read-client';
export type { ReadClient, ReadClientOptions } from './read-client';

export { ApiError, TransportError, ValidationError } from './errors';

export { contentVersionOf } from './content-version';

export type { ListParams } from './transport';
export type { QueueStorage } from './storage';
export type { EvictionReason } from './queue';
export type { IdSource } from './mint';

export type { ErrorCode, RecordPage, RecordResult, RecordStatus, StoredRecord, WireRecord } from './protocol';
export {
  MAX_APP_DATA_BYTES,
  MAX_RECORDS_PER_BATCH,
  MAX_REQUEST_BODY_BYTES,
  MAX_VERSION_LENGTH,
  READ_LIMIT_DEFAULT,
  READ_LIMIT_MAX,
} from './protocol';
