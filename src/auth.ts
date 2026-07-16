/**
 * Bearer-token identity.
 *
 * The client never declares who it is: identity is derived entirely from the presented key, so it
 * cannot be spoofed or misconfigured, and a leaked key is revocable without affecting anything else.
 */

/**
 * An app running at an instance — the only thing a key can grant, whatever its kind.
 *
 * `app` names the software module; `instance` names where it runs (a museum, or one copy of a
 * travelling exhibition). Neither identifies a record on its own: the pair does.
 */
export interface Installation {
  readonly appId: string;
  readonly instanceId: string;
}

/**
 * The `api_keys` row this principal was resolved from.
 *
 * Deliberately not on {@link Installation}: an installation is a fact about the world, and which
 * credential someone used to reach it is not part of what that credential grants. Both kinds carry
 * it because both kinds are keys.
 *
 * A schema surrogate on a principal, which `d1-record-store.ts` argues against for the installation
 * ("carries the business pair and deliberately not a schema surrogate"). That argument is about a
 * thing that *has* a business key to carry instead. A key's natural identifier is a hash we made
 * irreversible on purpose; this id is the only handle on it that exists — which is why the
 * submission log records it, and why revoking one station's key stops being a re-key of the
 * building. See `migrations/0004_*.sql`.
 */
interface Credential {
  readonly keyId: number;
}

/** Deposits records into one installation. Write-only: it can never read. */
export interface WritePrincipal extends Installation, Credential {
  readonly kind: 'write';
}

/**
 * Downloads one installation's records, incrementally. Read-only.
 *
 * Scoped exactly like a write key, and for the same reason: the scope of a read is authorization,
 * not a filter the caller picks. `GET /v1/records` therefore takes no app or instance parameter —
 * a read key that could name its own scope would be a read key that could name someone else's.
 *
 * There is deliberately no global variant. Every real download is "my installation's records"; a
 * genuine full-corpus export is rare, irreversible operator work that belongs in `wrangler d1
 * execute` next to the rest of the hand-typed SQL, not behind a token that can leak.
 */
export interface ReadPrincipal extends Installation, Credential {
  readonly kind: 'read';
}

export type Principal = WritePrincipal | ReadPrincipal;

/**
 * Extracts the token from an `Authorization: Bearer <key>` header.
 *
 * @returns the raw token, or null if the header is absent or is not a well-formed Bearer
 *   credential. Callers must not distinguish these cases to the client — both are 401.
 */
export function parseBearerToken(header: string | null): string | null {
  if (header === null) return null;

  // RFC 9110: the scheme is case-insensitive and separated from the token by one or more spaces.
  const match = /^[Bb][Ee][Aa][Rr][Ee][Rr] +(.+)$/.exec(header);
  if (match === null) return null;

  const token = match[1].trim();
  return token.length > 0 ? token : null;
}
