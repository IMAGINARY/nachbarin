/**
 * Bearer-token identity.
 *
 * The client never declares who it is: identity is derived entirely from the presented key, so it
 * cannot be spoofed or misconfigured, and a leaked key is revocable without affecting anything else.
 */

/**
 * One installation — an app running at an instance. Write-only: installations can never read.
 *
 * `app` names the software module; `instance` names where it runs (a museum, or one copy of a
 * travelling exhibition). Neither identifies a record on its own: the pair does.
 */
export interface InstallationPrincipal {
  readonly kind: 'installation';
  readonly appId: string;
  readonly instanceId: string;
}

/** The bulk/incremental download identity. Read-only. */
export interface ReadPrincipal {
  readonly kind: 'read';
}

export type Principal = InstallationPrincipal | ReadPrincipal;

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
