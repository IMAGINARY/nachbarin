/**
 * `purgeExpiredSubmissions` against a real (local) D1.
 *
 * Real D1 rather than a fake, because every claim worth making here is about the SQL: that the
 * comparison against a fixed-width RFC 3339 string really is chronological, that the boundary falls
 * where it is supposed to, and — above all — that the DELETE reaches exactly one table.
 *
 * The pool rolls storage back per test; `seedKeys` runs in `beforeAll`, which it copies into each
 * test's frame.
 */

import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { METADATA_RETENTION_DAYS } from '../src/config';
import { purgeExpiredSubmissions } from '../src/retention';
import { ID_WRITE, seedKeys } from './seed';

const NOW = new Date('2026-07-15T12:00:00.000Z');
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** `n` days before {@link NOW}, as the column stores it. */
const daysAgo = (n: number) => new Date(NOW.getTime() - n * MS_PER_DAY).toISOString();

let counter = 0;
const uuid = () => `3f8a0000-0000-4000-8000-${(++counter).toString(16).padStart(12, '0')}`;

/** One log row with a chosen `received_at`. Written by hand: this spec is not about the adapter. */
async function logRow(receivedAt: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO record_submissions (submission_id, installation_pk, key_id, client_id, created_at, received_at)
     VALUES (?1, 1, ?2, ?3, '2026-07-15T14:03:22+02:00', ?4)`,
  )
    .bind(uuid(), ID_WRITE, uuid(), receivedAt)
    .run();
}

const remaining = async (): Promise<string[]> => {
  const { results } = await env.DB.prepare('SELECT received_at FROM record_submissions ORDER BY received_at').all<{
    received_at: string;
  }>();
  return results.map((row) => row.received_at);
};

beforeAll(seedKeys);

describe('purgeExpiredSubmissions', () => {
  it('deletes rows past the retention window and keeps the rest', async () => {
    await logRow(daysAgo(200));
    await logRow(daysAgo(91));
    const kept = daysAgo(10);
    await logRow(kept);

    const deleted = await purgeExpiredSubmissions(env.DB, NOW);

    expect(deleted).toBe(2);
    expect(await remaining()).toEqual([kept]);
  });

  // The direction is arbitrary by one millisecond and must not be settled by accident: one way keeps
  // personal data a day past its window, the other deletes it a day early. A row exactly
  // METADATA_RETENTION_DAYS old has not yet *out*lived the window, so it stays.
  it('keeps a row exactly on the boundary and deletes the one a millisecond older', async () => {
    const onBoundary = daysAgo(METADATA_RETENTION_DAYS);
    const justOlder = new Date(NOW.getTime() - METADATA_RETENTION_DAYS * MS_PER_DAY - 1).toISOString();
    await logRow(onBoundary);
    await logRow(justOlder);

    const deleted = await purgeExpiredSubmissions(env.DB, NOW);

    expect(deleted).toBe(1);
    expect(await remaining()).toEqual([onBoundary]);
  });

  // The highest-stakes assertion in the file. `records` is the product: it holds no exact times, it
  // is not retention-limited, and a sweep that reached it would silently destroy the corpus the whole
  // service exists to collect — quietly, on a schedule, at 3am.
  it('never touches records', async () => {
    await env.DB.prepare(
      `INSERT INTO records (installation_pk, client_id, created_date, received_date, engine_version, app_data)
       VALUES (1, ?1, '2020-01-01', '2020-01-01', 'engine-1.4.2', '{}')`,
    )
      .bind(uuid())
      .run();
    await logRow(daysAgo(200));

    await purgeExpiredSubmissions(env.DB, NOW);

    // Dated years before the cutoff, and still there.
    const { results } = await env.DB.prepare('SELECT id FROM records').all();
    expect(results).toHaveLength(1);
  });

  it('reports zero rather than failing when there is nothing to purge', async () => {
    await logRow(daysAgo(1));

    expect(await purgeExpiredSubmissions(env.DB, NOW)).toBe(0);
    expect(await remaining()).toHaveLength(1);
  });

  it('measures the window from the passed clock, not the wall clock', async () => {
    const row = daysAgo(100);
    await logRow(row);

    // A run whose reference point is old enough that this row is inside the window.
    const earlier = new Date(NOW.getTime() - 50 * MS_PER_DAY);
    expect(await purgeExpiredSubmissions(env.DB, earlier)).toBe(0);

    expect(await purgeExpiredSubmissions(env.DB, NOW)).toBe(1);
  });

  // A swallowed failure here is a retention policy that has quietly stopped running, which is
  // indistinguishable from one that is running until someone audits the table.
  it('throws when D1 fails', async () => {
    await env.DB.prepare('DROP TABLE record_submissions').run();

    await expect(purgeExpiredSubmissions(env.DB, NOW)).rejects.toThrow();
  });
});
