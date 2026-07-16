/**
 * Request validation.
 *
 * Everything here is pure and synchronous: validation completes before storage is touched, so a
 * malformed request never reaches the database.
 */

import { MAX_APP_DATA_BYTES, MAX_RECORDS_PER_BATCH, MAX_VERSION_LENGTH, READ_LIMIT_DEFAULT, READ_LIMIT_MAX } from './config';
import type { ErrorCode } from './http';
import type { ListQuery, NewRecord } from './storage';

export type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export interface Failure {
  readonly code: ErrorCode;
  readonly message: string;
}

function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

function fail(code: ErrorCode, message: string): Result<never, Failure> {
  return { ok: false, error: { code, message } };
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const encoder = new TextEncoder();

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * Validates a `client_id` and normalizes it to lowercase.
 *
 * Any UUID version is accepted — clients using v7 for time-ordering are doing something sensible
 * and should not be blocked.
 *
 * Lowercasing matters because this is half of the dedupe key, and D1 stores it in a `TEXT` column
 * compared with BINARY collation: an uppercase UUID is simply a different string, so the same record
 * under two spellings would defeat `UNIQUE (installation_pk, client_id)` and store twice. Normalized
 * here, and CHECKed again in `migrations/0003_*.sql` so the invariant holds from both ends.
 *
 * The nil UUID is rejected, and that rejection is load-bearing rather than pedantic. `client_id`
 * is the idempotency key: a client that emits the nil UUID for every record — the classic
 * uninitialized-variable bug — would store exactly one record, and every record after it would
 * come back `duplicate`. This protocol defines `duplicate` as success, so the client would drop
 * each one from its queue. That is silent, total, unrecoverable data loss that looks from the
 * outside like a perfectly healthy pipeline.
 */
function validateClientId(value: unknown): Result<string, Failure> {
  if (typeof value !== 'string') return fail('invalid_field', 'client_id must be a string');
  if (!UUID_RE.test(value)) return fail('invalid_field', 'client_id must be a UUID');

  const normalized = value.toLowerCase();
  if (normalized === NIL_UUID) return fail('invalid_field', 'client_id must not be the nil UUID');

  return ok(normalized);
}

// The offset sign is matched but not captured: only its magnitude is range-checked.
const RFC3339_RE = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/;

/** Day 0 of month `m` (1-based) is the last day of month `m`, which handles leap years for free. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Validates an RFC 3339 timestamp, returning it verbatim.
 *
 * **`Date.parse` is deliberately not used, and must not be added.** It does not reject
 * out-of-range days — it silently rolls them over:
 *
 *     Date.parse('2026-02-30T00:00:00Z')  ->  2026-03-02   (not NaN)
 *     Date.parse('2025-02-29T00:00:00Z')  ->  2025-03-01   (not NaN)
 *
 * It *does* reject month 13 and day 32, which is exactly what makes it dangerous: it looks correct
 * on obvious bad input while corrupting the subtle cases by days. So every component is
 * range-checked here instead, days-in-month included.
 *
 * The string is returned unmodified rather than converted to a `Date`. The UTC offset carries the
 * exhibit's local wall-clock time, which is the analytically interesting value ("visits peak at
 * 14:00 local"), and converting here would discard it before storage ever gets a say.
 *
 * Out-of-range clocks are *not* rejected: a dead RTC reporting 1970 is accepted and stored. The
 * schema keeps a client-reported date and a server-observed one side by side (`created_date` and
 * `received_date`) precisely so that skew stays visible rather than being silently dropped at the
 * door. See {@link localDateOf}.
 */
function validateCreatedAt(value: unknown): Result<string, Failure> {
  if (typeof value !== 'string') return fail('invalid_field', 'created_at must be a string');

  const match = RFC3339_RE.exec(value);
  if (match === null) {
    return fail('invalid_field', 'created_at must be an RFC 3339 timestamp with a UTC offset');
  }

  const [, year, month, day, hour, minute, second, offsetHour, offsetMinute] = match;
  const y = Number(year);
  const mo = Number(month);
  const d = Number(day);

  if (mo < 1 || mo > 12) return fail('invalid_field', 'created_at has an invalid month');
  if (d < 1 || d > daysInMonth(y, mo)) return fail('invalid_field', 'created_at has an invalid day of month');
  if (Number(hour) > 23) return fail('invalid_field', 'created_at has an invalid hour');
  if (Number(minute) > 59) return fail('invalid_field', 'created_at has an invalid minute');
  // Leap seconds (:60) are legal RFC 3339 but nothing downstream can represent one.
  if (Number(second) > 59) return fail('invalid_field', 'created_at has an invalid second');

  if (offsetHour !== undefined && offsetMinute !== undefined) {
    if (Number(offsetHour) > 23 || Number(offsetMinute) > 59) {
      return fail('invalid_field', 'created_at has an invalid UTC offset');
    }
  }

  return ok(value);
}

/**
 * The local date of a validated `created_at` — `'YYYY-MM-DD'`.
 *
 * This is what `records.created_date` stores, and the exact time is then discarded rather than
 * persisted: a precise interaction timestamp is the field that could tie a visitor to their choices
 * given any other timed source (camera footage, a ticket scan), and `app_data` is not sensitive
 * enough to be worth pairing with one. The full timestamp goes to `record_submissions` instead —
 * no endpoint reads it, and it is swept after 90 days.
 *
 * A slice, and not any kind of conversion. `createdAt` has been through {@link validateCreatedAt},
 * so it is RFC 3339 with an explicit offset and its first ten characters are a well-formed date —
 * and because the offset is preserved rather than normalized to UTC, that date is *already* the
 * exhibit's local one. No timezone table, no offset arithmetic, and in particular no `Date`: parsing
 * to a `Date` would resolve the instant to UTC and hand back the wrong day for half the planet every
 * evening, which is precisely the bug this repo refuses to reintroduce.
 *
 * The one soft spot is a client reporting `Z` instead of its true offset — then this is the UTC date,
 * which can land a day early for the few hours around local midnight. Museums are shut then. If one
 * is ever not, that is a documented limitation rather than a silent error.
 */
export function localDateOf(createdAt: string): string {
  return createdAt.slice(0, 10);
}

function validateVersion(value: unknown, field: string): Result<string, Failure> {
  if (typeof value !== 'string') return fail('invalid_field', `${field} must be a string`);
  if (value.length === 0) return fail('invalid_field', `${field} must not be empty`);
  if (value.length > MAX_VERSION_LENGTH) {
    return fail('invalid_field', `${field} must be at most ${String(MAX_VERSION_LENGTH)} characters`);
  }
  return ok(value);
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

const RECORD_KEYS = ['client_id', 'created_at', 'engine_version', 'content_version', 'app_data'];

function unknownKeys(object: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(object).filter((key) => !allowed.includes(key));
}

function has(object: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

/**
 * Validates one record from a write batch.
 *
 * Fields are checked in a fixed order and the first failure wins, because a result carries a
 * single `error`. Fixing the order makes the output deterministic and therefore testable.
 *
 * `client_id` is checked first on purpose: the caller echoes it back in the result, so validating
 * it before anything else guarantees that a null echo means "the client_id itself was bad" and
 * never "some other field was bad and we lost the identifier".
 */
export function validateRecord(value: unknown): Result<NewRecord, Failure> {
  if (!isJsonObject(value)) return fail('invalid_field', 'record must be a JSON object');

  if (!has(value, 'client_id')) return fail('invalid_field', 'client_id is required');
  const clientId = validateClientId(value.client_id);
  if (!clientId.ok) return clientId;

  if (!has(value, 'created_at')) return fail('invalid_field', 'created_at is required');
  const createdAt = validateCreatedAt(value.created_at);
  if (!createdAt.ok) return createdAt;

  if (!has(value, 'engine_version')) return fail('invalid_field', 'engine_version is required');
  const engineVersion = validateVersion(value.engine_version, 'engine_version');
  if (!engineVersion.ok) return engineVersion;

  // Optional: an app may have no meaningful notion of content version. Absent becomes null, so
  // "this concept does not apply here" stays distinguishable from any real value.
  let contentVersion: string | null = null;
  if (has(value, 'content_version')) {
    const result = validateVersion(value.content_version, 'content_version');
    if (!result.ok) return result;
    contentVersion = result.value;
  }

  // `app_data` is opaque and must never be interpreted, so any JSON value is accepted — object,
  // array, or scalar. Only presence is required. `JSON.parse` output never contains `undefined`,
  // so the key check is what distinguishes an absent field from an explicit JSON null, and
  // `{"app_data": null}` is valid.
  if (!has(value, 'app_data')) return fail('invalid_field', 'app_data is required');
  // TypeScript types JSON.stringify as returning `string`, but it returns undefined for
  // undefined/function/symbol. JSON.parse output can never contain those, so this is unreachable
  // from the handler — but this function is exported and tests build records by hand.
  const appDataJson: string | undefined = JSON.stringify(value.app_data);
  if (appDataJson === undefined) return fail('invalid_field', 'app_data must be a JSON value');

  const appDataBytes = encoder.encode(appDataJson).byteLength;
  if (appDataBytes > MAX_APP_DATA_BYTES) {
    return fail('payload_too_large', `app_data is ${String(appDataBytes)} bytes; the limit is ${String(MAX_APP_DATA_BYTES)}`);
  }

  // The one concession to inspecting app_data, and it is a storage-portability constraint rather
  // than an interpretation of the content: Postgres `jsonb` cannot hold a NUL character inside a string, so
  // such a record would pass validation and then fail at insert time as an untraceable 500. We
  // already hold the serialized form for the size check, so catching it here costs nothing.
  if (appDataJson.includes('\\u0000')) {
    return fail('invalid_field', 'app_data must not contain the NUL character');
  }

  const extra = unknownKeys(value, RECORD_KEYS);
  if (extra.length > 0) {
    return fail('invalid_field', `unknown field(s): ${extra.join(', ')}`);
  }

  return ok({
    clientId: clientId.value,
    createdAt: createdAt.value,
    engineVersion: engineVersion.value,
    contentVersion,
    appDataJson,
  });
}

/** The envelope, before per-record validation. Individual records stay `unknown` here. */
export function validateWriteEnvelope(body: unknown): Result<unknown[], Failure> {
  if (!isJsonObject(body)) return fail('invalid_request', 'request body must be a JSON object');

  const extra = unknownKeys(body, ['records']);
  if (extra.length > 0) return fail('invalid_request', `unknown field(s): ${extra.join(', ')}`);

  if (!has(body, 'records')) return fail('invalid_request', 'records is required');
  const records: unknown = body.records;
  if (!Array.isArray(records)) return fail('invalid_request', 'records must be an array');

  // Checked before any per-record work: validating an enormous batch only to reject the whole
  // thing anyway would be a cheap way to burn our CPU.
  if (records.length > MAX_RECORDS_PER_BATCH) {
    return fail('batch_too_large', `${String(records.length)} records; the maximum is ${String(MAX_RECORDS_PER_BATCH)}`);
  }

  return ok(records);
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

// No `app` or `instance`: a read's scope is settled by the key, not chosen by the caller. Since
// unknown parameters are rejected below rather than ignored, a client still sending `?app=` gets a
// 400 naming it — not a silently different scope.
const QUERY_KEYS = ['after_id', 'limit', 'engine_version', 'content_version'];

/**
 * Parses a non-negative integer from a query parameter.
 *
 * `parseInt` is unusable here: it stops at the first non-digit, so `parseInt('1e5')` is `1` and
 * `parseInt('184002abc')` is `184002`. For a cursor, quietly reinterpreting the caller's value is
 * the worst possible failure. Hence an exact-match regex, then `Number`.
 */
function parseNonNegativeInt(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  // `id` is a bigserial (int8), which outruns JS's exact integer range. It takes ~9 quadrillion
  // records to matter, but the cursor is the contract, so make precision loss loud rather than silent.
  return Number.isSafeInteger(value) ? value : null;
}

function optionalFilter(raw: string | null, field: string, maxLength: number): Result<string | null, Failure> {
  if (raw === null) return ok(null);
  if (raw.length === 0) return fail('invalid_request', `${field} must not be empty`);
  if (raw.length > maxLength) {
    return fail('invalid_request', `${field} must be at most ${String(maxLength)} characters`);
  }
  return ok(raw);
}

/**
 * Validates read query parameters.
 *
 * Produces only what the caller may choose. The installation is not among it: that comes from the
 * key, which is why this stays a pure function of the URL and never sees a principal.
 *
 * Unknown and repeated parameters are rejected rather than ignored. This looks pedantic and is
 * not: `?after=184002` would leave `after_id` at its default, silently restarting the cursor at
 * zero, and the client would re-download and re-process the entire corpus while `has_more`
 * reported that everything was fine. Repeated parameters are the same failure wearing a different
 * hat, since `URLSearchParams.get` returns the first and discards the rest.
 *
 * The usual argument for leniency — forward compatibility — does not apply. That protects new
 * clients talking to old servers; there is exactly one Worker version live at a time, and the API
 * is already versioned in its path.
 */
export function validateReadQuery(params: URLSearchParams): Result<ListQuery, Failure> {
  const extra = [...new Set(params.keys())].filter((key) => !QUERY_KEYS.includes(key));
  if (extra.length > 0) return fail('invalid_request', `unknown query parameter(s): ${extra.join(', ')}`);

  const repeated = QUERY_KEYS.filter((key) => params.getAll(key).length > 1);
  if (repeated.length > 0) {
    return fail('invalid_request', `query parameter(s) given more than once: ${repeated.join(', ')}`);
  }

  let afterId = 0;
  const rawAfterId = params.get('after_id');
  if (rawAfterId !== null) {
    const parsed = parseNonNegativeInt(rawAfterId);
    if (parsed === null) return fail('invalid_request', 'after_id must be a non-negative integer');
    afterId = parsed;
  }

  let limit = READ_LIMIT_DEFAULT;
  const rawLimit = params.get('limit');
  if (rawLimit !== null) {
    const parsed = parseNonNegativeInt(rawLimit);
    // limit=0 is rejected rather than treated as "empty page": it would return no records with
    // has_more perpetually true, i.e. a polling loop that never advances.
    if (parsed === null || parsed < 1 || parsed > READ_LIMIT_MAX) {
      return fail('invalid_request', `limit must be an integer between 1 and ${String(READ_LIMIT_MAX)}`);
    }
    limit = parsed;
  }

  const engineVersion = optionalFilter(params.get('engine_version'), 'engine_version', MAX_VERSION_LENGTH);
  if (!engineVersion.ok) return engineVersion;

  const contentVersion = optionalFilter(params.get('content_version'), 'content_version', MAX_VERSION_LENGTH);
  if (!contentVersion.ok) return contentVersion;

  return ok({
    afterId,
    limit,
    engineVersion: engineVersion.value,
    contentVersion: contentVersion.value,
  });
}
