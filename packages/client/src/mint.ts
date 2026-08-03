/**
 * Minting the two fields this client supplies on the caller's behalf: `client_id` and `created_at`.
 *
 * Both are injectable (`newId`, `newCreatedAt`) and both are overridable per record, so nothing here
 * is mandatory. It is, however, what almost every caller will get.
 */

export type IdSource = 'crypto.randomUUID' | 'crypto.getRandomValues' | 'Math.random';

/**
 * What `globalThis.crypto` actually looks like across the runtimes this package targets — which is
 * not what `lib: ["DOM"]` claims. DOM declares `crypto: Crypto` as always present with
 * `randomUUID` always on it; in reality **both are optional**:
 *
 * - `randomUUID` is a secure-context-only API. A kiosk served over plain HTTP from something like
 *   `http://192.168.1.50` — ordinary exhibit hardware — has `crypto` but not `randomUUID`.
 *   `getRandomValues` has no such gate, which is why it is the second rung rather than a synonym
 *   for the first. This is the rung that actually fires in the field.
 * - `globalThis.crypto` missing entirely is no longer a supported case: it has been stable since
 *   Node 19 and this package's `engines` floor is 20. The bottom rung stays anyway, because it costs
 *   two lines and the alternative is an unattended kiosk that cannot start — see `newUuid` below. It
 *   probes rather than checking a version, so whatever exotic runtime omits `crypto` next is
 *   handled without anyone having to notice first.
 *
 * Hence the cast: it describes the runtime rather than the lib, and reading it through `globalThis`
 * also keeps the ladder stubbable in tests.
 */
interface CryptoLike {
  randomUUID?: () => string;
  getRandomValues?: (array: Uint8Array) => Uint8Array;
}

function cryptoRef(): CryptoLike | undefined {
  return (globalThis as { crypto?: CryptoLike }).crypto;
}

/** Which rung of the ladder is live right now. Reported through `state()` and one diagnostic. */
export function detectIdSource(): IdSource {
  const c = cryptoRef();
  if (typeof c?.randomUUID === 'function') return 'crypto.randomUUID';
  if (typeof c?.getRandomValues === 'function') return 'crypto.getRandomValues';
  return 'Math.random';
}

const HEX: readonly string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

function formatUuidV4(bytes: Uint8Array): string {
  // Version 4 in the high nibble of byte 6, variant 10x in the top bits of byte 8. Setting the
  // version nibble unconditionally is also what makes the nil UUID unreachable from here — it would
  // need byte 6 to be zero, and byte 6 is never zero after this line. That matters more than it
  // looks: the nil UUID is the one `client_id` the service refuses, precisely because a client
  // emitting it for every record would get `duplicate` forever and drop every record as "stored".
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const h = HEX;
  return (
    `${h[bytes[0]]}${h[bytes[1]]}${h[bytes[2]]}${h[bytes[3]]}-` +
    `${h[bytes[4]]}${h[bytes[5]]}-` +
    `${h[bytes[6]]}${h[bytes[7]]}-` +
    `${h[bytes[8]]}${h[bytes[9]]}-` +
    `${h[bytes[10]]}${h[bytes[11]]}${h[bytes[12]]}${h[bytes[13]]}${h[bytes[14]]}${h[bytes[15]]}`
  );
}

/**
 * A UUID, by whatever means the runtime allows. **This never throws.**
 *
 * That last part is the design decision, and it is deliberate. The alternative — refusing to
 * construct a client when no CSPRNG is reachable — loses every visitor's record on an
 * insecure-context kiosk, unattended, with nobody present to see the exception. `client_id` is an
 * idempotency key, not a security token: its only requirement is uniqueness within one installation
 * at the order of a dozen records an hour, and a `Math.random` v4 clears that by a wide margin.
 * Making the degraded case *visible* (see {@link detectIdSource}) is the right response; making it
 * fatal is not.
 */
export function newUuid(): string {
  const c = cryptoRef();

  if (typeof c?.randomUUID === 'function') {
    try {
      return c.randomUUID();
    } catch {
      // A polyfill that exists but refuses. Fall through rather than fail the write.
    }
  }

  const bytes = new Uint8Array(16);

  if (typeof c?.getRandomValues === 'function') {
    try {
      c.getRandomValues(bytes);
      return formatUuidV4(bytes);
    } catch {
      // Same again — fall through to the arithmetic fallback.
    }
  }

  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  return formatUuidV4(bytes);
}

// RFC 3339 can only spell years 0001..9999, and `created_at` is CHECKed against `\d{4}` at the far
// end. A clock far enough outside that range would produce a string the service rejects — so the
// value is clamped into it instead. A clamped timestamp is obviously, visibly wrong and is stored;
// a rejected one is a record lost. The service keeps `received_date` beside `created_date` for
// exactly this reason: skew is meant to stay legible, not to be a reason to drop data.
const MIN_LOCAL_MS = -62_135_596_800_000; // 0001-01-01T00:00:00.000Z
const MAX_LOCAL_MS = 253_402_300_799_999; // 9999-12-31T23:59:59.999Z

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/**
 * Formats an instant as RFC 3339 **in a named offset**, preserving that offset rather than
 * normalizing to UTC.
 *
 * Pure, and exported for that reason: it is how offsets like `+05:45` get tested, since this package
 * cannot reach `process.env.TZ` (`types: []` means `process` does not type-check) and the host's
 * real zone is not something a test may assume.
 *
 * `offsetMinutes` follows **`Date.prototype.getTimezoneOffset()` semantics — minutes to *add to
 * local* to get UTC** — so UTC+02:00 is `-120`. The sign that goes on the wire is therefore its
 * negation, which is the single easiest thing to get backwards in this file. Whole hours are not
 * assumed either: India is `-330` (`+05:30`), Nepal `-345` (`+05:45`), Chatham `-765` (`+12:45`).
 *
 * UTC is emitted as `+00:00` rather than `Z`. Both are legal, but `Z` is the one case where the
 * service's `created_date` slice can land a day early around local midnight, and a uniform string is
 * easier to eyeball in a log.
 */
export function formatRfc3339(epochMs: number, offsetMinutes: number): string {
  const offset = Number.isFinite(offsetMinutes) ? Math.trunc(offsetMinutes) : 0;
  const instant = Number.isFinite(epochMs) ? epochMs : 0;

  const shifted = Math.min(MAX_LOCAL_MS, Math.max(MIN_LOCAL_MS, instant - offset * 60_000));
  const local = new Date(shifted);

  // UTC getters on a pre-shifted instant: `local` is not a real instant, it is local wall-clock time
  // wearing UTC's clothes. Using the local getters here instead would apply the host's own zone on
  // top of the shift and be wrong by that zone.
  const date = `${pad(local.getUTCFullYear(), 4)}-${pad(local.getUTCMonth() + 1, 2)}-${pad(local.getUTCDate(), 2)}`;
  const time = `${pad(local.getUTCHours(), 2)}:${pad(local.getUTCMinutes(), 2)}:${pad(local.getUTCSeconds(), 2)}`;

  const wireOffset = -offset;
  const sign = wireOffset < 0 ? '-' : '+';
  const magnitude = Math.abs(wireOffset);

  return `${date}T${time}${sign}${pad(Math.trunc(magnitude / 60), 2)}:${pad(magnitude % 60, 2)}`;
}

/**
 * Now, in the host's own offset.
 *
 * One `Date` serves both arguments on purpose: `getTimezoneOffset()` is a function of the instant,
 * not a constant, so sampling the clock twice can straddle a DST transition and label a timestamp
 * with the offset from the other side of it.
 */
export function newCreatedAt(): string {
  const now = new Date();
  return formatRfc3339(now.getTime(), now.getTimezoneOffset());
}
