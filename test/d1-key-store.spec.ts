/**
 * `D1KeyStore` against real D1.
 *
 * The handler specs use `FakeKeyStore`, which stores keys verbatim; nothing there can observe
 * whether the real adapter hashes correctly, because hashing is an implementation detail of this
 * class rather than part of the `KeyStore` contract. This spec is what closes that gap.
 */

import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { D1KeyStore } from '../src/d1-key-store';
import {
  KEY_READER,
  KEY_REVOKED,
  KEY_UNKNOWN,
  KEY_WRITE,
  SEEDED_APP,
  SEEDED_APP_OTHER,
  SEEDED_INSTANCE,
  SEEDED_INSTANCE_OTHER,
  seedKeys,
} from './seed';

beforeAll(seedKeys);

const store = () => new D1KeyStore(env.DB);

describe('D1KeyStore.resolve', () => {
  // The golden fixtures are hashes of the documented minting command, computed outside this code.
  // If sha256Hex ever disagrees with `printf %s "$key" | shasum -a 256`, every key an operator mints
  // by the book 401s forever — and this is the only test that would notice.
  it('resolves a write key to its app and instance', async () => {
    expect(await store().resolve(KEY_WRITE)).toEqual({
      kind: 'write',
      appId: SEEDED_APP,
      instanceId: SEEDED_INSTANCE,
    });
  });

  // Seeded on a *different* installation from the write key on purpose. A read key's installation
  // is now what decides which records it may download, so resolving it to the wrong one would hand
  // an operator another museum's data — and with both keys on one installation, an implementation
  // that returned "whichever installation the join found" would pass this test.
  it('resolves a read key to its own app and instance', async () => {
    expect(await store().resolve(KEY_READER)).toEqual({
      kind: 'read',
      appId: SEEDED_APP_OTHER,
      instanceId: SEEDED_INSTANCE_OTHER,
    });
  });

  it('returns null for an unknown key', async () => {
    expect(await store().resolve(KEY_UNKNOWN)).toBeNull();
  });

  it('returns null for a revoked key', async () => {
    expect(await store().resolve(KEY_REVOKED)).toBeNull();
  });

  // The key is hashed, so the raw key must never appear in the table -- that is the entire point of
  // storing a digest. Presenting the stored hash *as* a key must not authenticate.
  it('does not accept the stored hash as if it were the key', async () => {
    const row = await env.DB.prepare('SELECT key_hash FROM api_keys WHERE kind = ?1').bind('read').first<{
      key_hash: string;
    }>();

    expect(row).not.toBeNull();
    expect(await store().resolve(row!.key_hash)).toBeNull();
  });

  it('is case- and whitespace-sensitive', async () => {
    expect(await store().resolve(KEY_WRITE.toUpperCase())).toBeNull();
    expect(await store().resolve(` ${KEY_WRITE}`)).toBeNull();
  });

  // A D1 failure must not be reported as "unknown key": null means 401, which tells a client its
  // credential is bad -- the one conclusion it must not draw from an outage, and one that could make
  // it stop retrying and discard queued records. Simulated by pointing the store at a database whose
  // table is gone.
  it('throws rather than returning null when the query fails', async () => {
    await env.DB.prepare('DROP TABLE api_keys').run();

    await expect(store().resolve(KEY_WRITE)).rejects.toThrow();
  });
});
