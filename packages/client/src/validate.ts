/**
 * Client-side pre-validation: every bound the service publishes as locally predictable, checked
 * before a record enters the queue.
 *
 * ## Why check at all
 *
 * `onResult` is best-effort and may never fire, so a rejection delivered only through it can be lost
 * entirely across a page reload. A record that can never be accepted would then sit in the queue
 * burning retries until the age cap swept it, with nothing anywhere saying why. Throwing at the call
 * site turns that into a stack trace pointing at the producer bug.
 *
 * ## Where the line is
 *
 * **This module checks only bounds `spec/openapi.yaml` states as client-predictable, re-declared in
 * `protocol.ts` and parity-tested. It never reimplements a server decision — only a server limit the
 * spec promises is computable locally.** So: sizes, lengths, formats. Not `app_data`'s structure
 * (opaque, and interpreting it is the one thing this service must never do), not dedupe, not scope.
 * If a future bound is not documented as predictable, it does not get checked here.
 *
 * There is deliberately no `validate: false` option. If it can be turned off it will be, and then
 * the failure is the silent one.
 */

import { ValidationError } from './errors';
import { MAX_APP_DATA_BYTES, MAX_VERSION_LENGTH, type WireRecord } from './protocol';

const encoder = new TextEncoder();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

// Mirrors the service's regex exactly: `T`/`t` and `Z`/`z` both accepted, fractional seconds
// optional and unbounded, offset `±HH:MM` or `Z`. A bare local time with no offset is not accepted —
// the offset is the whole point, since it is what makes `created_at` exhibit-local.
const RFC3339_RE = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/;

/** Day 0 of month `m` (1-based) is the last day of month `m`, which handles leap years for free. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Validates a `client_id` and normalizes it to lowercase.
 *
 * Any UUID version is accepted. The nil UUID is not: it is the classic uninitialized-variable bug,
 * and because it is the idempotency key, a client emitting it for every record would store exactly
 * one and get `duplicate` for the rest — which this protocol defines as success, so the client would
 * drop each from its queue. Silent, total data loss that looks healthy from outside.
 */
export function validateClientId(value: string): string {
  if (typeof value !== 'string') throw new ValidationError('client_id', 'client_id must be a string');
  if (!UUID_RE.test(value)) throw new ValidationError('client_id', 'client_id must be a UUID');

  const normalized = value.toLowerCase();
  if (normalized === NIL_UUID) throw new ValidationError('client_id', 'client_id must not be the nil UUID');

  return normalized;
}

/**
 * Validates an RFC 3339 timestamp, returning it verbatim.
 *
 * **`Date.parse` is deliberately not used, and must not be added.** It does not reject out-of-range
 * days — it rolls them over silently:
 *
 *     Date.parse('2026-02-30T00:00:00Z')  ->  2026-03-02   (not NaN)
 *     Date.parse('2025-02-29T00:00:00Z')  ->  2025-03-01   (not NaN)
 *
 * It *does* reject month 13 and day 32, which is what makes it dangerous: correct-looking on obvious
 * bad input while corrupting the subtle cases by days. Every component is range-checked instead.
 *
 * The string is returned unmodified rather than converted to a `Date`. The UTC offset carries the
 * exhibit's local wall-clock time, and the service slices the first ten characters off this to get
 * `created_date` — so normalizing to UTC here would hand back the wrong day for half the planet
 * every evening.
 *
 * An out-of-range clock is *not* rejected. A dead RTC reporting 1970 is a valid record; the service
 * keeps a server-observed date beside the client-reported one precisely so skew stays visible.
 */
export function validateCreatedAt(value: string): string {
  if (typeof value !== 'string') throw new ValidationError('created_at', 'created_at must be a string');

  const match = RFC3339_RE.exec(value);
  if (match === null) {
    throw new ValidationError('created_at', 'created_at must be an RFC 3339 timestamp with a UTC offset');
  }

  const [, year, month, day, hour, minute, second, offsetHour, offsetMinute] = match;
  const y = Number(year);
  const mo = Number(month);
  const d = Number(day);

  if (mo < 1 || mo > 12) throw new ValidationError('created_at', 'created_at has an invalid month');
  if (d < 1 || d > daysInMonth(y, mo)) throw new ValidationError('created_at', 'created_at has an invalid day of month');
  if (Number(hour) > 23) throw new ValidationError('created_at', 'created_at has an invalid hour');
  if (Number(minute) > 59) throw new ValidationError('created_at', 'created_at has an invalid minute');
  // Leap seconds (:60) are legal RFC 3339 but nothing downstream can represent one.
  if (Number(second) > 59) throw new ValidationError('created_at', 'created_at has an invalid second');

  if (offsetHour !== undefined && offsetMinute !== undefined) {
    if (Number(offsetHour) > 23 || Number(offsetMinute) > 59) {
      throw new ValidationError('created_at', 'created_at has an invalid UTC offset');
    }
  }

  return value;
}

export function validateVersion(value: string, field: string): string {
  if (typeof value !== 'string') throw new ValidationError(field, `${field} must be a string`);
  if (value.length === 0) throw new ValidationError(field, `${field} must not be empty`);
  if (value.length > MAX_VERSION_LENGTH) {
    throw new ValidationError(field, `${field} must be at most ${String(MAX_VERSION_LENGTH)} characters`);
  }
  return value;
}

/** A record after minting and before validation — what `write()` has assembled from its inputs. */
export interface RecordDraft {
  readonly clientId: string;
  readonly createdAt: string;
  readonly engineVersion: string;
  /**
   * `null` is admitted here only so it can be *rejected*. The public `NewRecordInput` types this as
   * `string | undefined`, so a TypeScript caller cannot reach that branch — but this package is
   * published and half its consumers are plain JavaScript, and "omitted" versus "null" is exactly
   * the distinction they will get wrong.
   */
  readonly contentVersion?: string | null | undefined;
  readonly appData: unknown;
}

export interface BuiltRecord {
  readonly wire: WireRecord;
  /** Byte length of this record's own JSON, used to build batches that cannot be a 413. */
  readonly bytes: number;
}

/**
 * Validates a draft and freezes it into its wire form.
 *
 * The `JSON.stringify` / `JSON.parse` round trip on `app_data` is doing two jobs at once, and both
 * matter:
 *
 * - **It detaches the payload.** A caller is free to mutate the object it handed us after `write()`
 *   returns — a game reusing one scratch object per visitor would otherwise send whatever that
 *   object contained at flush time, hours later, and the size we measured would be about a value
 *   that no longer exists.
 * - **It proves the payload is plain JSON.** What comes back out of `JSON.parse` has no `undefined`,
 *   no functions, no `toJSON` hooks, no prototype — so what is stored is exactly what will be sent.
 *
 * `app_data` is stored parsed rather than as the string: putting the string in would make the
 * queue envelope's own `JSON.stringify` escape every quote in it, inflating a 64 KiB payload to as
 * much as 128 KiB in a storage backend that has ~5 MB to give.
 */
export function buildWireRecord(draft: RecordDraft): BuiltRecord {
  const clientId = validateClientId(draft.clientId);
  const createdAt = validateCreatedAt(draft.createdAt);
  const engineVersion = validateVersion(draft.engineVersion, 'engine_version');

  // Absent and null are different to the service, and only absent is spellable — so `null` is
  // rejected here rather than quietly dropped, which would hide the caller's misunderstanding.
  let contentVersion: string | undefined;
  if (draft.contentVersion !== undefined) {
    if (draft.contentVersion === null) {
      throw new ValidationError('content_version', 'content_version must be omitted rather than null when it does not apply');
    }
    contentVersion = validateVersion(draft.contentVersion, 'content_version');
  }

  // `JSON.stringify` is typed as returning `string` but returns undefined for undefined, functions
  // and symbols. That is the only way `app_data` can be unserializable, and it is a caller bug.
  const appDataJson: string | undefined = JSON.stringify(draft.appData);
  if (appDataJson === undefined) {
    throw new ValidationError('app_data', 'app_data must be a JSON value (received undefined, a function, or a symbol)');
  }

  const appDataBytes = encoder.encode(appDataJson).byteLength;
  if (appDataBytes > MAX_APP_DATA_BYTES) {
    throw new ValidationError('app_data', `app_data is ${String(appDataBytes)} bytes; the limit is ${String(MAX_APP_DATA_BYTES)}`);
  }

  // The service refuses a NUL inside any string in `app_data` — a storage-portability constraint,
  // not an interpretation of the content. Matching its check exactly, escape sequence and all,
  // matters more than matching it precisely: this also fires on a payload containing the literal
  // six characters `\u0000`, and so does the service's, so the verdict agrees either way.
  if (appDataJson.includes('\\u0000')) {
    throw new ValidationError('app_data', 'app_data must not contain the NUL character');
  }

  const wire: WireRecord =
    contentVersion === undefined
      ? { client_id: clientId, created_at: createdAt, engine_version: engineVersion, app_data: JSON.parse(appDataJson) }
      : {
          client_id: clientId,
          created_at: createdAt,
          engine_version: engineVersion,
          content_version: contentVersion,
          app_data: JSON.parse(appDataJson),
        };

  return { wire, bytes: encoder.encode(JSON.stringify(wire)).byteLength };
}
