/**
 * Key generation and hashing for `key mint`.
 *
 * Pure and dependency-free so the handler in commands/key.ts stays orchestration-only and these two
 * functions are unit-testable without spawning wrangler. {@link hashKey} must agree byte for byte with
 * the Worker's `sha256Hex` (src/d1-key-store.ts) and with `printf %s "$key" | shasum -a 256`: UTF-8, no
 * trailing newline, lowercase hex. A golden-fixture test (keygen.spec.ts) pins that agreement — the
 * failure mode is a key that 401s forever, indistinguishable from a revoked one.
 */

import { createHash, randomBytes } from 'node:crypto';

/**
 * A fresh API key: 256 bits, base64url, unpadded (43 chars). Safe in an HTTP header and a URL — the same
 * value the README mints with `openssl rand -base64 32 | tr '+/' '-_' | tr -d =`.
 */
export function generateKey(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * sha256 of `key`, lowercase hex — the value stored in `api_keys.key_hash` (which CHECKs 64 lowercase-hex
 * chars). `update(key, 'utf8')` hashes exactly the key's bytes with no trailing newline, matching the
 * Worker's WebCrypto implementation.
 */
export function hashKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}
