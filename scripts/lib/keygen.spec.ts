import { describe, expect, it } from 'vitest';
import { generateKey, hashKey } from './keygen.ts';

// Golden (plaintext, hash) pairs duplicated verbatim from test/seed.ts, which is the source of truth but
// cannot be imported here: it does `import { env } from 'cloudflare:test'` (a Workers-pool-only virtual
// module) and keeps its HASH_* constants module-private. test/d1-key-store.spec.ts pins the Worker's
// sha256Hex against these same literals, so pinning the CLI's hashKey against them makes script<->Worker
// hash agreement transitive. Keep in sync with test/seed.ts if a fixture ever changes.
const GOLDEN: ReadonlyArray<readonly [key: string, hash: string]> = [
  ['test-write-key', '04c0218b3c6929c6638fa052827cc353c3e1eb3a432020f686e083aae900d6c4'],
  ['test-read-key', '1fe7a77d2fca400ab2b506da2b5c7a0bc9ab21853ba6ad65c049915ff64dfabb'],
  ['test-revoked-key', '53970244b433599bbd3e20d18a8f567a43c61db7447cd0a92e8b1f8a4b0a98f3'],
  ['test-read-key-museum-x', '5d01461eb12bd83cdae4076916509f5d56064e2a9ce2e180fd85a9b86d21d5cf'],
];

describe('hashKey', () => {
  it.each(GOLDEN)('matches the Worker golden hash for %s', (key, hash) => {
    expect(hashKey(key)).toBe(hash);
  });

  it('produces 64 lowercase-hex chars (the api_keys.key_hash CHECK)', () => {
    expect(hashKey('anything')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('generateKey', () => {
  it('is 43 chars of unpadded base64url (256 bits)', () => {
    expect(generateKey()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('is different every call', () => {
    expect(generateKey()).not.toBe(generateKey());
  });
});
