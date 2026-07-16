/**
 * What the edge knows about a request, and nothing the request itself claims.
 *
 * The counterpart to `auth.ts`: both turn a `Request` into a small value object via a pure function,
 * and both deliberately trust the network over the payload. Where `auth.ts` derives *who is allowed
 * to do this*, this derives *where it came from* — the IP, the geo Cloudflare resolved from it, and
 * the datacenter that took it. It all lands in `record_submissions`.
 *
 * **This module is total and cannot fail.** Every field degrades to null; there is no `Result`, no
 * throw, no validation verdict. That is not laziness about input handling — it is the requirement.
 * These values are written in the same transaction as the records they describe, so an extractor
 * that could reject a request would be an extractor that could take ingestion down, and it would do
 * so exactly when something unusual is happening. See `migrations/0004_*.sql`: a forensics table
 * must not refuse to record something because it looks wrong.
 *
 * The clamping here is what makes the schema's CHECKs unreachable rather than merely unlikely. Each
 * one restates a bound applied below, so it can only fire if this module and that table have drifted
 * apart — which is a bug worth stopping the batch for. Adding a CHECK there without a clamp here
 * turns an unexpected value from a null column into a permanent 500.
 *
 * On the typing: `request.cf` is `CfProperties | undefined`, and `CfProperties` extends
 * `Record<string, unknown>`, so every field reads as `unknown` rather than its declared type. That
 * is the correct treatment of an edge-supplied value and it is free — TypeScript forces the
 * narrowing below rather than letting a declared `string` be trusted. Do not parameterize `Request`
 * to recover the precise types: the declaration describes what Cloudflare sends on a good day, and
 * on a good day this module has nothing to do.
 */

/** Mirrors the nullable columns of `record_submissions`. */
export interface Provenance {
  /** The POST this belongs to. Shared by every record in one request. */
  readonly submissionId: string;
  readonly clientIp: string | null;
  readonly userAgent: string | null;
  /** ISO 3166-1 alpha-2, or `T1` for Tor. Two characters either way. */
  readonly country: string | null;
  readonly city: string | null;
  readonly asn: number | null;
  readonly asOrganization: string | null;
  /** IATA code of the Cloudflare datacenter, e.g. `FRA`. */
  readonly colo: string | null;
  /** IANA name, e.g. `Europe/Berlin`. Derived from the IP, so independent of the exhibit's claims. */
  readonly timezone: string | null;
}

// Mirror the CHECKs in `migrations/0004_*.sql`. Values are clamped to these, never rejected for
// exceeding them: a truncated user agent is still forensically useful, and a wedged installation is
// not. `MAX_IP` is an IPv6 address with an IPv4 tail, the longest form there is.
const MAX_IP = 45;
const MAX_USER_AGENT = 512;
const MAX_CITY = 128;
const MAX_AS_ORGANIZATION = 128;
const MAX_COLO = 8;
const MAX_TIMEZONE = 64;

/**
 * A non-empty string, clamped to `maxLength`. Anything else — a number, an object, `''` — is null.
 *
 * The empty-string case matters: the schema's `length(x) BETWEEN 1 AND n` bounds reject `''`, and a
 * blank header is "we were told nothing", which is what NULL already means. Two spellings of one
 * fact is how a query starts lying.
 */
function text(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, maxLength);
}

/**
 * Everything the edge told us about `request`.
 *
 * @param submissionId minted by the caller, not here, so this stays pure and assertable —
 *   `Deps.newSubmissionId` is the injection point, for the same reason `Deps.now` exists.
 */
export function provenanceOf(request: Request, submissionId: string): Provenance {
  // `Headers.get` is case-insensitive, so the header's spelling on the wire does not matter.
  //
  // CF-Connecting-IP and not X-Forwarded-For: Workers run before the proxy that appends the latter,
  // so it is simply absent here. True-Client-IP is Enterprise-only and, on a plan without it, is
  // whatever the caller chose to send.
  const clientIp = text(request.headers.get('cf-connecting-ip'), MAX_IP);
  const userAgent = text(request.headers.get('user-agent'), MAX_USER_AGENT);

  // `undefined` under `vitest-pool-workers` unless a test passes `cf` to the Request, and every
  // field within it is independently optional in production. Nothing below may assume any of it.
  //
  // Note `wrangler dev` is the opposite trap: it fetches *real* properties from Cloudflare, so a
  // local `npm run dev` writes your own city and ISP into your local database. Useful for seeing
  // this work; not a fixture, and not a reason to believe any given field will be there in
  // production.
  const cf = request.cf;

  return {
    submissionId,
    clientIp,
    userAgent,
    country: country(cf?.country),
    city: text(cf?.city, MAX_CITY),
    asn: asn(cf?.asn),
    asOrganization: text(cf?.asOrganization, MAX_AS_ORGANIZATION),
    colo: text(cf?.colo, MAX_COLO),
    timezone: text(cf?.timezone, MAX_TIMEZONE),
  };
}

/**
 * Alpha-2, or `T1` for Tor. Clamped by *rejection* rather than truncation — the one exception here.
 *
 * Truncating would turn 'DEU' into 'DE', inventing a fact from a value we evidently did not
 * understand. A wrong country is worse than no country: nobody chases a null, and everybody trusts
 * a code.
 *
 * Matched against ASCII rather than measured with `.length`, because `cf_country` is the only bound
 * in the schema that is an equality (`length(cf_country) = 2`) and equality is the unsafe direction.
 * `.length` counts UTF-16 code units and SQLite's `length()` counts characters, so a single astral
 * character — `'𝕏'.length === 2`, `length('𝕏') = 1` — would pass a `.length === 2` guard and then
 * fail the CHECK, which on this table is a wedged client rather than a dropped column. Every other
 * field clamps with `slice`, which can only ever *reduce* the count, so this asymmetry is the reason
 * only this one needs the stricter test.
 */
const COUNTRY_RE = /^[A-Za-z0-9]{2}$/;

function country(value: unknown): string | null {
  return typeof value === 'string' && COUNTRY_RE.test(value) ? value : null;
}

/**
 * An ASN: an integer in the 32-bit unsigned range, or null.
 *
 * The upper bound is not decoration. `Number.isInteger` is true of `1e21`, which is a perfectly good
 * JS integer and far outside SQLite's 64-bit range — so it would land in the INTEGER column as REAL
 * and fail the schema's `typeof(cf_asn) = 'integer'` CHECK, which on this table means a rolled-back
 * batch rather than a null column. `Number.isSafeInteger` would also close that (2^53 < 2^63), but
 * 32 bits is the honest bound: ASNs are 32-bit (RFC 6793), so anything above it was never an ASN.
 *
 * The lower bound and the integer test cover the other half of what affinity will not convert: a
 * float stays REAL, and text that is not a well-formed integer literal stays TEXT. Either sits in
 * the column comparing equal to no ASN ever after.
 */
const MAX_ASN = 0xffffffff;

function asn(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= MAX_ASN ? value : null;
}
