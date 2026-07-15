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
import { KEY_INSTALLATION, KEY_READER, KEY_REVOKED, KEY_UNKNOWN, SEEDED_APP, SEEDED_INSTANCE, seedKeys } from './seed';

beforeAll(seedKeys);

const store = () => new D1KeyStore(env.DB);

describe('D1KeyStore.resolve', () => {
  // The golden fixtures are hashes of the documented minting command, computed outside this code.
  // If sha256Hex ever disagrees with `printf %s "$key" | shasum -a 256`, every key an operator mints
  // by the book 401s forever — and this is the only test that would notice.
  it('resolves an installation key to its app and instance', async () => {
    expect(await store().resolve(KEY_INSTALLATION)).toEqual({
      kind: 'installation',
      appId: SEEDED_APP,
      instanceId: SEEDED_INSTANCE,
    });
  });

  // The LEFT in the LEFT JOIN. A read key has no installation row to join to, so an inner join
  // returns nothing and every bulk download 401s — invisible to any test using only write keys.
  it('resolves a read key, which has no installation', async () => {
    expect(await store().resolve(KEY_READER)).toEqual({ kind: 'read' });
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
    expect(await store().resolve(KEY_INSTALLATION.toUpperCase())).toBeNull();
    expect(await store().resolve(` ${KEY_INSTALLATION}`)).toBeNull();
  });

  // A D1 failure must not be reported as "unknown key": null means 401, which tells a client its
  // credential is bad -- the one conclusion it must not draw from an outage, and one that could make
  // it stop retrying and discard queued records. Simulated by pointing the store at a database whose
  // table is gone.
  it('throws rather than returning null when the query fails', async () => {
    await env.DB.prepare('DROP TABLE api_keys').run();

    await expect(store().resolve(KEY_INSTALLATION)).rejects.toThrow();
  });
});
