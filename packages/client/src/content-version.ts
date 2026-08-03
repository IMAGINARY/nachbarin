/**
 * Fingerprinting content, so that `content_version` does not have to be remembered.
 *
 * A version string that has to be bumped by hand is a version string that eventually lies. Hashing
 * the content instead makes the field always correct and never a chore: two records carry the same
 * `content_version` exactly when the visitors saw the same thing.
 *
 * The digest is `sha256:` followed by 64 lowercase hex characters — 71 in all, against a 256
 * character limit, so the length is free. Hex rather than base64 because it is what every tool
 * prints, so a stored value is paste-and-compare against any of them:
 *
 * ```
 * printf %s "$content" | shasum -a 256
 * ```
 *
 * (`echo` appends a newline and hashes something else.) The encoding also has to survive a URL,
 * because `content_version` is a read filter as well as a stored value: hex is `[0-9a-f]` and the
 * prefix's colon is legal in a query value, so `?content_version=sha256:…` can be typed by hand
 * unescaped. Base64 could not — its `+` decodes to a space, so an operator's curl would come back
 * empty rather than wrong-looking.
 */

/**
 * `sha256:` + the hex SHA-256 of `content`. **This throws when `crypto.subtle` is missing**, and
 * that is the deliberate opposite of `newUuid` in mint.ts, which never throws.
 *
 * The difference is what the two values are for. A `client_id` only has to be unique, so a degraded
 * random source is visible-but-harmless and refusing to mint one would lose every visitor's record.
 * A content hash only has to be *the same string for the same content* — so falling back to a second
 * algorithm would produce two different values for one game script depending on where the page was
 * served from, with the records looking perfectly fine either way. That is not a degraded version of
 * this feature; it is the feature inverted. Failing loudly at startup, on a developer's machine, is
 * the only honest response.
 *
 * The gap this guards is one specific deployment. `crypto.subtle` is secure-context-only, but
 * `http://localhost`, `http://127.0.0.1`, `http://*.localhost` and `file://` all qualify — so a
 * kiosk browser pointed at a local server has it, and one served from something like
 * `http://192.168.1.50` does not. Node is not a gap: Web Crypto has been a stable global since
 * Node 19 and this package's `engines` floor is 20. The check is on the condition rather than a
 * version regardless, so a runtime that omits `crypto` still gets a legible error instead of a
 * `TypeError` about reading `digest` of undefined. Either way the answer is to hash the content in
 * the build instead; the README carries the recipe and the message below points at it.
 *
 * Call this **once, at startup**, and pass the result as `createWriteClient({ contentVersion })` —
 * not per record. Nothing enforces that, because a size limit on a fingerprint would be a limit on
 * the wrong thing.
 */
export async function contentVersionOf(content: string | Uint8Array): Promise<string> {
  // The cast describes the runtime rather than the lib: `lib: ["DOM"]` declares `crypto` as always
  // present with `subtle` on it, and both are optional in reality. Same hatch as mint.ts and
  // storage.ts, and reading it through `globalThis` also keeps it stubbable in tests.
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (subtle === undefined) {
    throw new Error(
      'crypto.subtle is unavailable, so contentVersionOf cannot run. In a browser it needs a secure ' +
        'context (https:, http://localhost, http://127.0.0.1 or file:); in Node it needs v19 or ' +
        'newer, and this package requires v20. Hash the content in your build instead, or supply ' +
        'contentVersion yourself — see the README.',
    );
  }

  // TypeScript 5.7 narrowed `BufferSource` to views backed by an `ArrayBuffer`, which a plain
  // `Uint8Array` — `Uint8Array<ArrayBufferLike>` — no longer satisfies. `digest` takes one happily at
  // runtime, and narrowing the parameter to `Uint8Array<ArrayBuffer>` instead would reject the
  // ordinary `Uint8Array` every consumer actually holds. So the assertion lives here, not in the
  // signature.
  const bytes = (typeof content === 'string' ? new TextEncoder().encode(content) : content) as BufferSource;
  const digest = await subtle.digest('SHA-256', bytes);

  // `padStart` is the whole reason this is a function rather than a line in the README. Without it
  // any byte below 0x10 loses its leading zero, and the result is a shorter string that still looks
  // like a hash — non-empty, under 256 characters, refused by nothing. It would store cleanly and
  // only fail years later, when a digest that should match does not.
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `sha256:${hex}`;
}
