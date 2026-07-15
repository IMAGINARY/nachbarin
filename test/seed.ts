/**
 * Golden key fixtures for the specs that run against real D1.
 *
 * Not a `*.spec.ts` file, so vitest does not collect it.
 *
 * **The hashes are hardcoded on purpose.** Deriving them by calling the adapter's own `sha256Hex`
 * would make the tests a tautology that passes for any digest function, including a wrong one. Each
 * was produced with the exact command the README documents for minting a key:
 *
 *     printf %s 'test-installation-key' | shasum -a 256
 *
 * so they pin the adapter to the operator's procedure — which is where the real failure lives. Note
 * `printf %s` and not `echo`: `echo` appends a newline and yields a completely different hash, and
 * therefore a key that 401s forever, indistinguishably from a revoked one.
 */

import { env } from 'cloudflare:test';

export const KEY_INSTALLATION = 'test-installation-key';
export const KEY_READER = 'test-read-key';
export const KEY_REVOKED = 'test-revoked-key';
export const KEY_UNKNOWN = 'test-unknown-key';

const HASH_INSTALLATION = '6240bbadbdc187c564aa576336fb7643cde34416bd534ea816a31b65a3b6c276';
const HASH_READER = '1fe7a77d2fca400ab2b506da2b5c7a0bc9ab21853ba6ad65c049915ff64dfabb';
const HASH_REVOKED = '53970244b433599bbd3e20d18a8f567a43c61db7447cd0a92e8b1f8a4b0a98f3';

export const SEEDED_APP = 'future-mobility-simulator';
export const SEEDED_INSTANCE = 'museum-x';

/**
 * Seeds one installation and three keys: a working write key, a working read key, and a revoked
 * write key. Call from `beforeAll` — the pool copies suite-level storage into each test's frame, and
 * undoes only what the test itself writes.
 */
export async function seedKeys(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('INSERT INTO installations (id, app_id, instance_id, label) VALUES (1, ?1, ?2, ?3)').bind(
      SEEDED_APP,
      SEEDED_INSTANCE,
      'Seeded by test/seed.ts',
    ),
    env.DB.prepare(
      `INSERT INTO api_keys (key_hash, kind, installation_pk, label, revoked_at) VALUES
         (?1, 'installation', 1,    'write key',   NULL),
         (?2, 'read',         NULL, 'read key',    NULL),
         (?3, 'installation', 1,    'revoked key', '2026-07-01T00:00:00.000Z')`,
    ).bind(HASH_INSTALLATION, HASH_READER, HASH_REVOKED),
  ]);
}
