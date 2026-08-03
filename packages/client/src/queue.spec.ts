import { describe, expect, it } from 'vitest';
import { type QueueLimits, RecordQueue } from './queue';
import { MAX_RECORDS_PER_BATCH } from './protocol';
import { buildWireRecord } from './validate';
import { createFakeStorage, FIXED_CREATED_AT, testUuid } from './test-support';

const NOW = Date.UTC(2026, 6, 15, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

const LIMITS: QueueLimits = { maxRecords: 500, maxBytes: 2 * 1024 * 1024, maxAgeMs: DAY };

function built(appData: unknown = { choice: 'bus' }) {
  return buildWireRecord({ clientId: testUuid(), createdAt: FIXED_CREATED_AT, engineVersion: 'engine-1.4.2', appData });
}

function makeQueue(limits: Partial<QueueLimits> = {}, initial: string | null = null) {
  const storage = createFakeStorage(initial);
  return { storage, queue: new RecordQueue(storage, { ...LIMITS, ...limits }) };
}

describe('persistence', () => {
  it('survives being written and restored', () => {
    const { storage, queue } = makeQueue();
    queue.restore(NOW);
    const { record } = queue.enqueue(built(), NOW);
    queue.noteAttempt(NOW, false);
    queue.persist();

    const restored = new RecordQueue(storage, LIMITS);
    restored.restore(NOW);

    expect(restored.size).toBe(1);
    expect(restored.snapshot()[0].wire.client_id).toBe(record.wire.client_id);
    expect(restored.failures).toBe(1);
    expect(restored.lastAttemptAt).toBe(NOW);
  });

  it('resumes seq above the highest restored one', () => {
    // Not from the stored counter alone: if that is corrupt, a fresh record could take a seq a
    // queued one already holds, and one flush would then remove both.
    const { storage, queue } = makeQueue();
    queue.restore(NOW);
    queue.enqueue(built(), NOW);
    queue.enqueue(built(), NOW);
    queue.persist();

    const tampered = (JSON.parse(storage.value ?? '{}') as { seq: number }).seq;
    storage.value = JSON.stringify({ ...JSON.parse(storage.value ?? '{}'), seq: 0 });
    expect(tampered).toBeGreaterThan(0);

    const restored = new RecordQueue(storage, LIMITS);
    restored.restore(NOW);
    const fresh = restored.enqueue(built(), NOW).record;

    const seqs = restored.snapshot().map((entry) => entry.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(fresh.seq).toBeGreaterThan(
      Math.max(
        ...restored
          .snapshot()
          .slice(0, 2)
          .map((e) => e.seq),
      ),
    );
  });

  it.each([
    ['not JSON', '{'],
    ['null', 'null'],
    ['an array', '[]'],
    ['a wrong version', '{"v":99,"records":[]}'],
    ['records that are not an array', '{"v":1,"records":{}}'],
    ['empty', ''],
  ])('resets to empty when the stored value is %s', (_label, value) => {
    // A throw here would be a kiosk whose game cannot start because of a bad string in
    // localStorage — strictly worse than losing the queue that string describes.
    const { queue } = makeQueue({}, value);
    expect(() => queue.restore(NOW)).not.toThrow();
    expect(queue.size).toBe(0);
  });

  it('drops individual rows that are not records, keeping the rest', () => {
    const good = built();
    const stored = JSON.stringify({
      v: 1,
      seq: 5,
      lastAttemptAt: null,
      failures: 0,
      records: [
        { seq: 1, queuedAt: NOW, bytes: good.bytes, wire: good.wire },
        null,
        { seq: 2, queuedAt: NOW, bytes: 10 },
        { seq: 3, queuedAt: NOW, bytes: 10, wire: { client_id: 'x' } },
      ],
    });

    const { queue } = makeQueue({}, stored);
    queue.restore(NOW);
    expect(queue.size).toBe(1);
  });

  it('keeps a record whose app_data is an explicit null', () => {
    // `app_data: null` is a valid payload and means something different from an absent one, so the
    // revival check has to test presence rather than truthiness.
    const record = built(null);
    const stored = JSON.stringify({
      v: 1,
      seq: 2,
      lastAttemptAt: null,
      failures: 0,
      records: [{ seq: 1, queuedAt: NOW, bytes: record.bytes, wire: record.wire }],
    });

    const { queue } = makeQueue({}, stored);
    queue.restore(NOW);
    expect(queue.size).toBe(1);
    expect(queue.snapshot()[0].wire.app_data).toBeNull();
  });

  it('sheds the oldest and retries once when the store refuses', () => {
    const { storage, queue } = makeQueue();
    queue.restore(NOW);
    for (let i = 0; i < 10; i++) queue.enqueue(built(), NOW);
    queue.persist();

    storage.failNextWrites = 1;
    const result = queue.persist();

    expect(result.ok).toBe(true);
    expect(result.evicted).toHaveLength(1);
    expect(result.evicted[0].reason).toBe('bytes');
    expect(queue.size).toBe(9);
  });

  it('keeps every record when the store refuses twice', () => {
    // In-memory is the truth; persistence is a mirror. Losing the mirror must not lose the record —
    // and the records shed to make room go back, because shedding is only justified by having
    // worked. Otherwise a full origin quota would cost data and buy nothing.
    const { storage, queue } = makeQueue();
    queue.restore(NOW);
    const a = queue.enqueue(built(), NOW).record;
    const b = queue.enqueue(built(), NOW).record;

    storage.failAlways = true;
    const result = queue.persist();

    expect(result.ok).toBe(false);
    expect(result.error).toBeInstanceOf(Error);
    expect(result.evicted).toHaveLength(0);
    expect(queue.snapshot().map((entry) => entry.seq)).toEqual([a.seq, b.seq]);
  });

  it('does not latch after a persist failure', () => {
    const { storage, queue } = makeQueue();
    queue.restore(NOW);
    queue.enqueue(built(), NOW);

    storage.failAlways = true;
    queue.persist();
    storage.failAlways = false;

    // Whatever filled the origin's quota can free up without anyone telling us.
    expect(queue.persist().ok).toBe(true);
  });
});

describe('caps', () => {
  it('evicts the oldest past the record cap', () => {
    const { queue } = makeQueue({ maxRecords: 3 });
    queue.restore(NOW);

    const first = queue.enqueue(built(), NOW).record;
    queue.enqueue(built(), NOW);
    queue.enqueue(built(), NOW);
    const { record: fourth, evicted } = queue.enqueue(built(), NOW);

    expect(evicted).toHaveLength(1);
    expect(evicted[0].record.seq).toBe(first.seq);
    expect(evicted[0].reason).toBe('count');
    expect(queue.size).toBe(3);
    // The record just written is never the one thrown away.
    expect(queue.snapshot().some((entry) => entry.seq === fourth.seq)).toBe(true);
  });

  it('evicts past the byte cap, which is the one that fits the store', () => {
    const { queue } = makeQueue({ maxBytes: 400 });
    queue.restore(NOW);

    for (let i = 0; i < 20; i++) queue.enqueue(built({ padding: 'x'.repeat(50) }), NOW);

    expect(queue.bytes).toBeLessThanOrEqual(400);
    expect(queue.size).toBeGreaterThan(0);
  });

  it('never evicts down to nothing on the byte cap', () => {
    // One record over the whole cap is still a record we can send; dropping it buys nothing.
    const { queue } = makeQueue({ maxBytes: 1 });
    queue.restore(NOW);
    queue.enqueue(built(), NOW);
    queue.enqueue(built(), NOW);

    expect(queue.size).toBe(1);
  });

  it('evicts by age, on restore as well as on demand', () => {
    const { storage, queue } = makeQueue({ maxAgeMs: DAY });
    queue.restore(NOW);
    queue.enqueue(built(), NOW);
    queue.persist();

    const later = new RecordQueue(storage, { ...LIMITS, maxAgeMs: DAY });
    const evicted = later.restore(NOW + DAY + 1);

    expect(evicted).toHaveLength(1);
    expect(evicted[0].reason).toBe('age');
    expect(later.size).toBe(0);
  });

  it('evicts nothing when the clock has moved backwards', () => {
    // Negative age is confusing, not old. Only a forward jump can evict — the correct reading of
    // "too old" when a wall clock is the only evidence there is.
    const { queue } = makeQueue({ maxAgeMs: DAY });
    queue.restore(NOW);
    queue.enqueue(built(), NOW);

    expect(queue.sweepAge(NOW - 10 * DAY)).toHaveLength(0);
    expect(queue.size).toBe(1);
  });
});

describe('batching', () => {
  it('caps a batch at the service limit and comes back for the rest', () => {
    const { queue } = makeQueue();
    queue.restore(NOW);
    for (let i = 0; i < 250; i++) queue.enqueue(built(), NOW);

    const first = queue.buildBatch();
    expect(first).toHaveLength(MAX_RECORDS_PER_BATCH);

    queue.remove(new Set(first.map((entry) => entry.seq)));
    expect(queue.buildBatch()).toHaveLength(MAX_RECORDS_PER_BATCH);
  });

  it('takes the oldest first', () => {
    const { queue } = makeQueue();
    queue.restore(NOW);
    const a = queue.enqueue(built(), NOW).record;
    const b = queue.enqueue(built(), NOW).record;

    expect(queue.buildBatch().map((entry) => entry.seq)).toEqual([a.seq, b.seq]);
  });

  it('bounds a batch by bytes as well as by count', () => {
    // Byte-aware batching is what makes a 413 unreachable, rather than something to recover from.
    const { queue } = makeQueue();
    queue.restore(NOW);
    // Each of these is ~64 KiB, so 100 of them would be 6.4 MB against a budget of ~7.5 MB. Fill
    // enough that the count cap is not what stops it.
    for (let i = 0; i < 200; i++) queue.enqueue(built({ padding: 'x'.repeat(64 * 1024 - 200) }), NOW);

    const batch = queue.buildBatch();
    const bytes = batch.reduce((total, entry) => total + entry.bytes, 0);

    expect(batch.length).toBeLessThanOrEqual(MAX_RECORDS_PER_BATCH);
    expect(bytes).toBeLessThanOrEqual(Math.floor(8 * 1024 * 1024 * 0.9));
  });

  it('returns at least one record from a non-empty queue', () => {
    // A batch builder that can return empty from a non-empty queue is a queue that never drains,
    // and the failure would be silent.
    const { queue } = makeQueue();
    queue.restore(NOW);
    queue.enqueue(built({ padding: 'x'.repeat(64 * 1024 - 200) }), NOW);

    expect(queue.buildBatch()).toHaveLength(1);
  });
});

describe('removal', () => {
  it('removes by seq against the live array, keeping a record enqueued mid-flush', () => {
    // This is the whole reason `seq` exists. A flush snapshots a batch, awaits a POST, and then
    // removes — and anything written during that await must survive. Assigning a remembered
    // snapshot back over the array would discard it silently.
    const { queue } = makeQueue();
    queue.restore(NOW);
    const a = queue.enqueue(built(), NOW).record;
    const batch = queue.buildBatch();

    const duringFlush = queue.enqueue(built(), NOW).record;
    queue.remove(new Set(batch.map((entry) => entry.seq)));

    expect(queue.size).toBe(1);
    expect(queue.snapshot()[0].seq).toBe(duringFlush.seq);
    expect(queue.snapshot()[0].seq).not.toBe(a.seq);
  });

  it('removes both entries when one client_id was queued twice', () => {
    // Callers may supply their own client_id, so a batch can legitimately carry one twice. Removal
    // keyed by client_id would be ambiguous; by seq it is not.
    const { queue } = makeQueue();
    queue.restore(NOW);
    const shared = testUuid();
    const wire = { clientId: shared, createdAt: FIXED_CREATED_AT, engineVersion: 'engine-1.4.2', appData: 1 };

    const a = queue.enqueue(buildWireRecord(wire), NOW).record;
    const b = queue.enqueue(buildWireRecord(wire), NOW).record;
    expect(a.wire.client_id).toBe(b.wire.client_id);

    queue.remove(new Set([a.seq]));
    expect(queue.size).toBe(1);
    expect(queue.snapshot()[0].seq).toBe(b.seq);
  });
});
