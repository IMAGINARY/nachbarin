/**
 * The durable send queue.
 *
 * This module owns the in-memory array, its mirror in {@link QueueStorage}, and every rule about
 * what enters and leaves it. It knows nothing about HTTP; the write client drives it.
 *
 * ## `seq`, and why removal is not by `client_id`
 *
 * Every queued record carries a monotonic `seq` that never goes on the wire. Removal after a flush
 * is by `seq`, for the same reason the service cannot key its results by `client_id`: a batch may
 * legitimately carry the same `client_id` twice, because callers are allowed to supply their own.
 * Position maps a result to a batch entry; `seq` maps that entry to a row in the live queue.
 *
 * "Live" is the load-bearing word. A flush operates on a batch snapshot, but removal targets the
 * array as it is *now* — so a `write()` that landed while the POST was in flight is still there
 * afterwards. Assigning a remembered snapshot back over the array would silently discard it.
 *
 * ## The two caps, and why a count alone will not do
 *
 * `app_data` can be 64 KiB, so a hundred records is 6.4 MB against a Web Storage quota of roughly
 * five. The byte cap is what actually keeps the queue inside its store; the record cap is what is
 * legible to whoever reads the options. Both are enforced, oldest-out.
 */

import { MAX_RECORDS_PER_BATCH, MAX_REQUEST_BODY_BYTES, type WireRecord } from './protocol';
import type { QueueStorage } from './storage';
import type { BuiltRecord } from './validate';

/**
 * Batches are built to this, not to {@link MAX_REQUEST_BODY_BYTES}.
 *
 * The margin covers the `{"records":[…]}` envelope and the commas, which the per-record byte counts
 * do not include. Its real job is to make a 413 unreachable rather than to be tight: an oversized
 * batch is a whole-batch failure, and the alternative to preventing it is adaptive halving, which is
 * a retry loop that has to guess.
 */
const BATCH_BYTE_BUDGET = Math.floor(MAX_REQUEST_BODY_BYTES * 0.9);

/** Fraction of the queue shed when the store refuses a write, before retrying it once. */
const PERSIST_RETRY_EVICTION_FRACTION = 0.1;

export type EvictionReason = 'count' | 'bytes' | 'age';

export interface QueuedRecord {
  readonly seq: number;
  /** When this client enqueued it — server-independent, and the clock the age cap uses. */
  readonly queuedAt: number;
  readonly bytes: number;
  readonly wire: WireRecord;
}

export interface Eviction {
  readonly record: QueuedRecord;
  readonly reason: EvictionReason;
}

export interface QueueLimits {
  readonly maxRecords: number;
  readonly maxBytes: number;
  readonly maxAgeMs: number;
}

/** What `persist()` reports back. `evicted` is non-empty only when the store refused a write. */
export interface PersistResult {
  readonly ok: boolean;
  readonly evicted: readonly Eviction[];
  readonly error?: unknown;
}

interface Envelope {
  readonly v: 1;
  readonly seq: number;
  readonly lastAttemptAt: number | null;
  readonly failures: number;
  readonly records: readonly QueuedRecord[];
}

const ENVELOPE_VERSION = 1;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads one queued record back out of storage, or `null` if it is not one.
 *
 * Everything here has been through `buildWireRecord` on the way in, so a row that fails these checks
 * did not come from this version of this client — a hand-edited store, a half-written value, a
 * future envelope shape. Dropping the row is the only safe reading: keeping a malformed record would
 * put a request on the wire that the service rejects forever.
 */
function reviveRecord(value: unknown): QueuedRecord | null {
  if (!isObject(value)) return null;

  const { seq, queuedAt, bytes, wire } = value;
  if (typeof seq !== 'number' || !Number.isFinite(seq)) return null;
  if (typeof queuedAt !== 'number' || !Number.isFinite(queuedAt)) return null;
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return null;
  if (!isObject(wire)) return null;

  const { client_id: clientId, created_at: createdAt, engine_version: engineVersion, content_version: contentVersion } = wire;
  if (typeof clientId !== 'string' || typeof createdAt !== 'string' || typeof engineVersion !== 'string') return null;
  if (contentVersion !== undefined && typeof contentVersion !== 'string') return null;
  // `app_data` is opaque and any JSON value is legal, `null` included — so presence is all there is
  // to check, and `in` is the only operator that can tell presence from an explicit null.
  if (!('app_data' in wire)) return null;

  return { seq, queuedAt, bytes, wire: wire as unknown as WireRecord };
}

export class RecordQueue {
  readonly #storage: QueueStorage;
  readonly #limits: QueueLimits;

  #records: QueuedRecord[] = [];
  #nextSeq = 1;
  #lastAttemptAt: number | null = null;
  #failures = 0;

  constructor(storage: QueueStorage, limits: QueueLimits) {
    this.#storage = storage;
    this.#limits = limits;
  }

  get size(): number {
    return this.#records.length;
  }

  get bytes(): number {
    return this.#records.reduce((total, record) => total + record.bytes, 0);
  }

  get isEmpty(): boolean {
    return this.#records.length === 0;
  }

  get lastAttemptAt(): number | null {
    return this.#lastAttemptAt;
  }

  get failures(): number {
    return this.#failures;
  }

  /**
   * Loads whatever is in storage.
   *
   * Any failure to make sense of the stored value resets to an empty queue rather than throwing.
   * This runs inside `createWriteClient`, and a throw here would mean a kiosk whose game cannot
   * start because of a bad string in `localStorage` — strictly worse than losing the queue it
   * describes.
   */
  restore(now: number): readonly Eviction[] {
    let parsed: unknown;
    try {
      const raw = this.#storage.read();
      parsed = raw === null ? null : JSON.parse(raw);
    } catch {
      parsed = null;
    }

    if (!isObject(parsed) || parsed.v !== ENVELOPE_VERSION || !Array.isArray(parsed.records)) {
      this.#records = [];
      this.#nextSeq = 1;
      this.#lastAttemptAt = null;
      this.#failures = 0;
      return [];
    }

    const envelope = parsed as unknown as Envelope;

    this.#records = envelope.records.map(reviveRecord).filter((record): record is QueuedRecord => record !== null);

    // Above the highest restored `seq`, never from the stored counter alone: if the counter is
    // corrupt or absent, a fresh record could otherwise take a `seq` that a queued one already
    // holds, and one flush would then remove both.
    const highest = this.#records.reduce((max, record) => Math.max(max, record.seq), 0);
    const stored = typeof envelope.seq === 'number' && Number.isFinite(envelope.seq) ? envelope.seq : 0;
    this.#nextSeq = Math.max(highest + 1, stored, 1);

    this.#lastAttemptAt =
      typeof envelope.lastAttemptAt === 'number' && Number.isFinite(envelope.lastAttemptAt) ? envelope.lastAttemptAt : null;
    this.#failures =
      typeof envelope.failures === 'number' && Number.isFinite(envelope.failures) && envelope.failures >= 0 ? envelope.failures : 0;

    return this.sweepAge(now);
  }

  /** Appends a validated record and trims to both caps. The new record is never the one evicted. */
  enqueue(built: BuiltRecord, now: number): { readonly record: QueuedRecord; readonly evicted: readonly Eviction[] } {
    const record: QueuedRecord = { seq: this.#nextSeq++, queuedAt: now, bytes: built.bytes, wire: built.wire };
    this.#records.push(record);
    return { record, evicted: this.#trim() };
  }

  /**
   * Evicts records that have waited longer than the age cap.
   *
   * A record whose age comes out negative — the clock moved backwards, which on hardware with a
   * failing RTC it does — is not old, it is confusing, and it survives. Only a *forward* jump can
   * evict, which is the correct reading of "too old" when a wall clock is the only evidence there is.
   */
  sweepAge(now: number): readonly Eviction[] {
    const maxAge = this.#limits.maxAgeMs;
    const kept: QueuedRecord[] = [];
    const evicted: Eviction[] = [];

    for (const record of this.#records) {
      if (now - record.queuedAt > maxAge) evicted.push({ record, reason: 'age' });
      else kept.push(record);
    }

    this.#records = kept;
    return evicted;
  }

  /**
   * The next batch, oldest first, bounded by both the record count and the byte budget.
   *
   * At least one record is always returned from a non-empty queue, even if it alone exceeds the
   * budget. That case cannot arise — `app_data` is capped far below it — but a batch builder that
   * can return empty from a non-empty queue is a queue that never drains, and that failure would be
   * silent.
   */
  buildBatch(): readonly QueuedRecord[] {
    const batch: QueuedRecord[] = [];
    let bytes = 0;

    for (const record of this.#records) {
      if (batch.length >= MAX_RECORDS_PER_BATCH) break;
      if (batch.length > 0 && bytes + record.bytes > BATCH_BYTE_BUDGET) break;
      batch.push(record);
      bytes += record.bytes;
    }

    return batch;
  }

  /** Removes records by `seq`, against the live array rather than any snapshot. */
  remove(seqs: ReadonlySet<number>): void {
    if (seqs.size === 0) return;
    this.#records = this.#records.filter((record) => !seqs.has(record.seq));
  }

  /** Records the outcome of an attempt. `failures` is what the backoff ladder is computed from. */
  noteAttempt(now: number, succeeded: boolean): void {
    this.#lastAttemptAt = now;
    this.#failures = succeeded ? 0 : this.#failures + 1;
  }

  /**
   * Mirrors the queue into storage.
   *
   * A store can refuse a write at any moment, and the response is neither to throw nor to pretend:
   * the in-memory array is the truth and persistence is a best-effort mirror of it.
   *
   * A refusal sheds the oldest slice and tries once more, because "too big" is the one cause the
   * queue's own contents can do anything about. But the records are **held aside rather than
   * dropped**, and go back if the second attempt fails too — shedding is only justified by having
   * worked. Otherwise a store refusing for reasons of its own (another page filled the origin's
   * quota, site data was revoked mid-session) would cost records and buy nothing, which is the one
   * outcome worse than not persisting at all.
   *
   * Nothing latches either. The next mutation tries again, because that other page's quota can free
   * up without anyone telling us.
   */
  persist(): PersistResult {
    try {
      this.#storage.write(this.#serialize());
      return { ok: true, evicted: [] };
    } catch {
      const shed = this.#records.splice(0, Math.max(1, Math.ceil(this.#records.length * PERSIST_RETRY_EVICTION_FRACTION)));

      try {
        this.#storage.write(this.#serialize());
        return { ok: true, evicted: shed.map((record) => ({ record, reason: 'bytes' as const })) };
      } catch (retryError) {
        this.#records.unshift(...shed);
        return { ok: false, evicted: [], error: retryError };
      }
    }
  }

  /** Every queued record, oldest first. For `state()` and for tests; not a live view. */
  snapshot(): readonly QueuedRecord[] {
    return [...this.#records];
  }

  #serialize(): string {
    const envelope: Envelope = {
      v: ENVELOPE_VERSION,
      seq: this.#nextSeq,
      lastAttemptAt: this.#lastAttemptAt,
      failures: this.#failures,
      records: this.#records,
    };
    return JSON.stringify(envelope);
  }

  #trim(): readonly Eviction[] {
    const evicted: Eviction[] = [];

    while (this.#records.length > this.#limits.maxRecords) {
      evicted.push({ record: this.#records.shift() as QueuedRecord, reason: 'count' });
    }

    // Down to one, never to zero: a single record over the whole byte cap is still a record we can
    // send, and dropping it would be the one eviction that buys nothing.
    let total = this.bytes;
    while (total > this.#limits.maxBytes && this.#records.length > 1) {
      const dropped = this.#records.shift() as QueuedRecord;
      total -= dropped.bytes;
      evicted.push({ record: dropped, reason: 'bytes' });
    }

    return evicted;
  }
}
