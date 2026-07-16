/**
 * Golden key fixtures for the specs that run against real D1.
 *
 * Not a `*.spec.ts` file, so vitest does not collect it.
 *
 * **The hashes are hardcoded on purpose.** Deriving them by calling the adapter's own `sha256Hex`
 * would make the tests a tautology that passes for any digest function, including a wrong one. Each
 * was produced with the exact command the README documents for minting a key:
 *
 *     printf %s 'test-write-key' | shasum -a 256
 *
 * so they pin the adapter to the operator's procedure — which is where the real failure lives. Note
 * `printf %s` and not `echo`: `echo` appends a newline and yields a completely different hash, and
 * therefore a key that 401s forever, indistinguishably from a revoked one.
 */

import { env } from 'cloudflare:test';

export const KEY_WRITE = 'test-write-key';
export const KEY_READER = 'test-read-key';
export const KEY_REVOKED = 'test-revoked-key';
export const KEY_UNKNOWN = 'test-unknown-key';

/**
 * A read key on the *same* installation as {@link KEY_WRITE}, which is what makes a write-then-read
 * round trip expressible at all — {@link KEY_READER} is on the other installation by design.
 *
 * Keeping both read keys is the point: this one proves a reader can see what was written, and
 * {@link KEY_READER} proves it sees nothing else.
 */
export const KEY_READER_SAME = 'test-read-key-museum-x';

/**
 * Key ids, assigned rather than left to the rowid.
 *
 * `record_submissions.key_id` records which key wrote a record, so a spec has to be able to say what
 * the right answer is. Spelled out for the same reason the installation ids are: an implicit id is
 * an id the test has to go and read back, and a test that reads the answer out of the database
 * cannot notice the database being wrong.
 *
 * Deliberately not 1..4. They must not coincide with `installation_pk` (1 and 2), or a store that
 * logged the installation into `key_id` would pass.
 */
export const ID_WRITE = 41;
export const ID_READER = 42;
export const ID_REVOKED = 43;
export const ID_READER_SAME = 44;

const HASH_WRITE = '04c0218b3c6929c6638fa052827cc353c3e1eb3a432020f686e083aae900d6c4';
const HASH_READER = '1fe7a77d2fca400ab2b506da2b5c7a0bc9ab21853ba6ad65c049915ff64dfabb';
const HASH_REVOKED = '53970244b433599bbd3e20d18a8f567a43c61db7447cd0a92e8b1f8a4b0a98f3';
const HASH_READER_SAME = '5d01461eb12bd83cdae4076916509f5d56064e2a9ce2e180fd85a9b86d21d5cf';

export const SEEDED_APP = 'future-mobility-simulator';
export const SEEDED_INSTANCE = 'museum-x';

/**
 * A second installation, holding the read key.
 *
 * The read key deliberately does *not* share an installation with the write key. If both sat on
 * installation 1, `resolve` could return "whichever installation the join happened to find" and
 * every assertion would still pass — the spec could not tell that apart from returning the key's
 * own installation, which is the thing that now decides what a bulk download may see.
 */
export const SEEDED_APP_OTHER = 'visitor-survey';
export const SEEDED_INSTANCE_OTHER = 'museum-y';

/**
 * Seeds two installations and four keys: a write key, a revoked write key and a read key on the
 * first, and a read key on the second. Call from `beforeAll` — the pool copies suite-level storage
 * into each test's frame, and undoes only what the test itself writes.
 */
export async function seedKeys(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('INSERT INTO installations (id, app_id, instance_id, label) VALUES (1, ?1, ?2, ?3)').bind(
      SEEDED_APP,
      SEEDED_INSTANCE,
      'Seeded by test/seed.ts',
    ),
    env.DB.prepare('INSERT INTO installations (id, app_id, instance_id, label) VALUES (2, ?1, ?2, ?3)').bind(
      SEEDED_APP_OTHER,
      SEEDED_INSTANCE_OTHER,
      'Seeded by test/seed.ts',
    ),
    env.DB.prepare(
      `INSERT INTO api_keys (id, key_hash, kind, installation_pk, label, revoked_at) VALUES
         (?1, ?5, 'write', 1, 'write key',        NULL),
         (?2, ?6, 'read',  2, 'read key',         NULL),
         (?3, ?7, 'write', 1, 'revoked key',      '2026-07-01T00:00:00.000Z'),
         (?4, ?8, 'read',  1, 'read key, inst 1', NULL)`,
    ).bind(ID_WRITE, ID_READER, ID_REVOKED, ID_READER_SAME, HASH_WRITE, HASH_READER, HASH_REVOKED, HASH_READER_SAME),
  ]);
}
