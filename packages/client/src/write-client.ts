/**
 * The write client: `write()` returns immediately, and the record leaves the building whenever it
 * can.
 *
 * ## The shape of the problem
 *
 * This runs in a kiosk browser on a museum floor. The page reloads itself every few minutes as a
 * soft reset, the machine's disk is a read-only overlay wiped nightly, the network may be down for
 * hours, and there is nobody standing there to see an error or press retry. So `write()` cannot be a
 * `fetch` that might fail. It puts the record in a durable queue and returns; a timer drains that
 * queue in the background and does not stop trying.
 *
 * Because the queue is durable and `client_id` makes writes idempotent, **an interrupted flush is
 * not data loss** — the page can reload mid-POST and the record is simply sent again, coming back
 * `duplicate` if the first attempt actually landed. That single property is what makes the rest of
 * this simple, and it is why there is no `sendBeacon`, no `keepalive`, and no unload handler.
 *
 * ## The timer
 *
 * One timer, one deadline, armed only while there is something to send. After every attempt the next
 * one is scheduled at `flushIntervalMs` if it succeeded and at the backoff delay if it did not — so
 * an outage settles at the ceiling rather than hammering, and an empty queue schedules nothing at
 * all.
 *
 * It is armed **at construction** when the restored queue is non-empty, which is not an optimisation:
 * after a reload nothing calls `write()`, and a kiosk with no visitor for an hour would otherwise
 * never drain what the last one left.
 *
 * A pending timer holds a Node event loop open exactly as `setInterval` would. That is deliberate
 * rather than solved — the process staying alive while it still owes the service records is the
 * correct behaviour — and `close()` is the way out.
 *
 * ## What it never does
 *
 * It never drops a queued record because of a 4xx. See `transport.ts` for why that rule exists and
 * what the single exception is.
 */

import type { EvictionReason, QueuedRecord } from './queue';
import { RecordQueue } from './queue';
import { detectIdSource, type IdSource, newCreatedAt as defaultCreatedAt, newUuid } from './mint';
import { createMemoryStorage, type QueueStorage, resolveDefaultStorage } from './storage';
import type { ErrorCode, RecordResult } from './protocol';
import { normalizeBaseUrl, postRecords, type RetryReason, type Transport } from './transport';
import { buildWireRecord } from './validate';

/** Bound on an honoured `Retry-After`. A cooperative header should not be able to stall a kiosk for a day. */
const MAX_RETRY_AFTER_MS = 15 * 60 * 1000;

const DEFAULTS = {
  requestTimeoutMs: 30_000,
  flushIntervalMs: 60_000,
  maxQueueRecords: 500,
  maxQueueBytes: 2 * 1024 * 1024,
  maxRecordAgeMs: 24 * 60 * 60 * 1000,
  maxBatchesPerFlush: 10,
  backoffInitialMs: 1_000,
  backoffMaxMs: 5 * 60 * 1000,
  storageKey: 'nachbarin.queue.v1',
} as const;

export interface WriteClientOptions {
  /** Service root, e.g. `https://nachbarin.example.workers.dev`. A path prefix is preserved. */
  readonly baseUrl: string;
  /**
   * A `write` API key. Which installation it covers is a property of the key — the service takes
   * identity and scope from it alone. There is no `app` or `instance` option and there will not be.
   */
  readonly apiKey: string;
  /** Default `engine_version` for every record. Overridable per record. */
  readonly engineVersion: string;
  /** Default `content_version`. Omit it entirely when the app has no such notion; do not pass null. */
  readonly contentVersion?: string;
  /**
   * Transport injection point. Defaults to the global `fetch`.
   *
   * **Pass it bound** — `globalThis.fetch.bind(globalThis)`. A browser's `fetch` throws
   * "Illegal invocation" when called with the wrong receiver, and passing `globalThis.fetch` bare is
   * the easy way to arrive there.
   */
  readonly fetch?: typeof globalThis.fetch;
  /** Per HTTP request, not per flush cycle. Default 30s. */
  readonly requestTimeoutMs?: number;
  /** How long after an attempt the next one is scheduled, when the last one succeeded. Default 60s. */
  readonly flushIntervalMs?: number;
  /** Oldest-out once the queue is longer than this. Default 500. */
  readonly maxQueueRecords?: number;
  /**
   * Oldest-out once the queue is bigger than this. Default 2 MiB.
   *
   * This is the cap that matters: Web Storage gives an origin roughly 5 MB, and a record's
   * `app_data` may be 64 KiB, so a count alone does not bound anything useful.
   */
  readonly maxQueueBytes?: number;
  /** Records that have waited longer than this are dropped unsent. Default 24 hours. */
  readonly maxRecordAgeMs?: number;
  /** Runaway guard on one flush cycle. Default 10 batches, i.e. up to 1000 records. */
  readonly maxBatchesPerFlush?: number;
  readonly backoffInitialMs?: number;
  readonly backoffMaxMs?: number;
  /**
   * Where the queue lives. Defaults to `localStorage` when it is genuinely usable, memory otherwise.
   * Pass `null` to force memory even in a browser.
   */
  readonly storage?: QueueStorage | null;
  /** Key within that storage. Two clients may not share one — see {@link createWriteClient}. */
  readonly storageKey?: string;
  /** Overrides `client_id` minting. Must return a non-nil UUID. */
  readonly newId?: () => string;
  /** Overrides `created_at` minting. Must return RFC 3339 **with an explicit offset**. */
  readonly newCreatedAt?: () => string;
  /** Told about things worth knowing that are not any single record's business. Never called with visitor data. */
  readonly onDiagnostic?: (event: DiagnosticEvent) => void;
}

export interface NewRecordInput {
  /** Anything JSON-serializable, `null` included. Opaque to the service and to this client. */
  readonly appData: unknown;
  readonly engineVersion?: string;
  readonly contentVersion?: string;
  /** Supply your own idempotency key. Must be a non-nil UUID; one is minted otherwise. */
  readonly clientId?: string;
  /**
   * Supply your own `created_at` — RFC 3339 with an explicit offset, never normalized to UTC.
   *
   * Useful when the moment being recorded is not the moment of the call: a game that ended at 14:03
   * and is written at 14:05 after a consent dialog should say 14:03.
   */
  readonly createdAt?: string;
}

export type RecordOutcome =
  | { readonly status: 'created'; readonly clientId: string }
  | { readonly status: 'duplicate'; readonly clientId: string }
  | { readonly status: 'rejected'; readonly clientId: string; readonly error: ErrorCode | null; readonly message?: string }
  | { readonly status: 'evicted'; readonly clientId: string; readonly reason: EvictionReason };

export type DiagnosticEvent =
  | { readonly type: 'id_source'; readonly source: IdSource }
  | { readonly type: 'storage_not_persistent' }
  | { readonly type: 'storage_write_failed'; readonly detail: string }
  | { readonly type: 'records_evicted'; readonly reason: EvictionReason; readonly count: number }
  | {
      readonly type: 'flush_failed';
      readonly reason: RetryReason;
      readonly status: number | null;
      readonly code: ErrorCode | null;
      readonly detail: string;
      readonly failures: number;
      readonly nextAttemptInMs: number;
    };

export interface FlushResult {
  /** Records the service acknowledged this cycle, by any of the three verdicts. */
  readonly acknowledged: number;
  readonly batches: number;
  /** Still queued when the cycle ended. Non-zero after a success means the batch cap was reached. */
  readonly queued: number;
  /** Whether the last attempt in the cycle succeeded. */
  readonly ok: boolean;
}

export interface WriteClientState {
  readonly queued: number;
  readonly queuedBytes: number;
  readonly consecutiveFailures: number;
  readonly lastAttemptAt: number | null;
  /** False when the queue will not survive a reload. */
  readonly persistent: boolean;
  readonly idSource: IdSource;
  readonly closed: boolean;
}

export interface WriteClient {
  /**
   * Queues a record and returns its `client_id`.
   *
   * Synchronous, and durable by the time it returns. Throws `ValidationError` for a record the
   * service could never accept — a producer bug, surfaced at the call site rather than as a silent
   * `rejected` hours later.
   *
   * `onResult` is **best-effort within this page lifetime**: it fires when this record's fate is
   * decided while this client object is still alive, and silently never fires if a reload intervenes
   * first. The callback lives in memory and is not persisted alongside the queue, which is the whole
   * of the reason. Do not build anything on it that must not be missed.
   */
  write(record: NewRecordInput, options?: { readonly onResult?: (outcome: RecordOutcome) => void }): string;
  /**
   * Runs a flush cycle now, or joins the one already running.
   *
   * **Never rejects.** Inspect `ok` and `queued` on the result. Resolving does not mean the queue is
   * empty — a cycle stops at `maxBatchesPerFlush` or at the first failure.
   */
  flush(): Promise<FlushResult>;
  state(): WriteClientState;
  /** Stops the timer and releases the storage key. Awaits any cycle already in flight. */
  close(): Promise<void>;
}

/**
 * Storage keys currently spoken for, in this realm.
 *
 * Two clients on one key means two in-memory queues each overwriting the other's persisted state,
 * and two timers doing it concurrently. The likely causes are all mundane — a React StrictMode
 * double-mount, a hot reload, a module that constructs one at import time and again on demand — and
 * the symptom is records that vanish rather than an error. So it is an error.
 */
const activeStorageKeys = new Set<string>();

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

class WriteClientImpl implements WriteClient {
  readonly #transport: Transport;
  readonly #queue: RecordQueue;
  readonly #storageKey: string;
  readonly #persistent: boolean;
  readonly #idSource: IdSource;

  readonly #engineVersion: string;
  readonly #contentVersion: string | undefined;
  readonly #flushIntervalMs: number;
  readonly #maxBatchesPerFlush: number;
  readonly #backoffInitialMs: number;
  readonly #backoffMaxMs: number;
  readonly #newId: () => string;
  readonly #newCreatedAt: () => string;
  readonly #onDiagnostic: ((event: DiagnosticEvent) => void) | undefined;

  /** Keyed by the queue's own `seq`, never by `client_id` — a batch may carry one twice. */
  readonly #callbacks = new Map<number, (outcome: RecordOutcome) => void>();

  /**
   * Aborted by `close()`, so closing does not mean waiting out a request timeout.
   *
   * Safe because an abandoned POST is not data loss: the records were never removed from the queue,
   * and `client_id` makes re-sending them idempotent whether or not the aborted request landed.
   */
  readonly #lifetime = new AbortController();

  #timer: ReturnType<typeof setTimeout> | undefined;
  #inFlight: Promise<FlushResult> | null = null;
  #retryAfterMs: number | null = null;
  /**
   * The delay decided for the next attempt, held so it is decided exactly once.
   *
   * Backoff carries jitter, so recomputing it would make the `nextAttemptInMs` in a diagnostic a
   * different number from the one the timer actually used — a reader chasing a retry storm would be
   * reading fiction. Cleared whenever an attempt changes the failure count.
   */
  #plannedDelayMs: number | null = null;
  #closed = false;

  constructor(options: WriteClientOptions) {
    const storageKey = options.storageKey ?? DEFAULTS.storageKey;
    if (activeStorageKeys.has(storageKey)) {
      throw new Error(
        `a write client is already using the storage key ${JSON.stringify(storageKey)}; ` +
          "two clients sharing one key overwrite each other's queue. Call close() on the first, or pass a distinct storageKey.",
      );
    }
    activeStorageKeys.add(storageKey);
    this.#storageKey = storageKey;

    this.#transport = {
      baseUrl: normalizeBaseUrl(options.baseUrl),
      apiKey: options.apiKey,
      fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
      timeoutMs: options.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs,
    };

    const resolved =
      options.storage === undefined
        ? resolveDefaultStorage(storageKey)
        : options.storage === null
          ? { storage: createMemoryStorage(), persistent: false }
          : { storage: options.storage, persistent: true };

    this.#persistent = resolved.persistent;
    this.#queue = new RecordQueue(resolved.storage, {
      maxRecords: options.maxQueueRecords ?? DEFAULTS.maxQueueRecords,
      maxBytes: options.maxQueueBytes ?? DEFAULTS.maxQueueBytes,
      maxAgeMs: options.maxRecordAgeMs ?? DEFAULTS.maxRecordAgeMs,
    });

    this.#engineVersion = options.engineVersion;
    this.#contentVersion = options.contentVersion;
    this.#flushIntervalMs = options.flushIntervalMs ?? DEFAULTS.flushIntervalMs;
    this.#maxBatchesPerFlush = options.maxBatchesPerFlush ?? DEFAULTS.maxBatchesPerFlush;
    this.#backoffInitialMs = options.backoffInitialMs ?? DEFAULTS.backoffInitialMs;
    this.#backoffMaxMs = options.backoffMaxMs ?? DEFAULTS.backoffMaxMs;
    this.#newId = options.newId ?? newUuid;
    this.#newCreatedAt = options.newCreatedAt ?? defaultCreatedAt;
    this.#onDiagnostic = options.onDiagnostic;
    this.#idSource = detectIdSource();

    // Restored records have no callbacks — they outlived the page that registered them — so the
    // evictions this returns are reported to nobody. That is the honest behaviour, not a gap.
    const expired = this.#queue.restore(Date.now());
    this.#reportEvictions(expired);
    if (expired.length > 0) this.#persist();

    this.#emit({ type: 'id_source', source: this.#idSource });
    if (!this.#persistent) this.#emit({ type: 'storage_not_persistent' });

    this.#armForRestoredQueue();
  }

  write(record: NewRecordInput, options?: { readonly onResult?: (outcome: RecordOutcome) => void }): string {
    if (this.#closed) throw new Error('this write client is closed');

    // `in` rather than `??`: an explicit `contentVersion: null` must reach validation and be
    // rejected there, because omitting the field and nulling it mean different things to the service
    // and only omitting is spellable. `??` would silently swap the null for the default.
    const contentVersion = 'contentVersion' in record ? record.contentVersion : this.#contentVersion;

    const built = buildWireRecord({
      clientId: record.clientId ?? this.#newId(),
      createdAt: record.createdAt ?? this.#newCreatedAt(),
      engineVersion: record.engineVersion ?? this.#engineVersion,
      contentVersion,
      appData: record.appData,
    });

    const { record: queued, evicted } = this.#queue.enqueue(built, Date.now());
    if (options?.onResult !== undefined) this.#callbacks.set(queued.seq, options.onResult);

    this.#persist();
    this.#reportEvictions(evicted);

    // Flush now only from a clean slate. During backoff a busy exhibit would otherwise turn one
    // failing endpoint into a request per visitor, which is the behaviour backoff exists to prevent.
    if (this.#inFlight === null && this.#queue.failures === 0) void this.flush();
    else this.#rearm();

    return built.wire.client_id;
  }

  flush(): Promise<FlushResult> {
    if (this.#inFlight !== null) return this.#inFlight;
    const cycle = this.#cycle();
    this.#inFlight = cycle;
    return cycle;
  }

  state(): WriteClientState {
    return {
      queued: this.#queue.size,
      queuedBytes: this.#queue.bytes,
      consecutiveFailures: this.#queue.failures,
      lastAttemptAt: this.#queue.lastAttemptAt,
      persistent: this.#persistent,
      idSource: this.#idSource,
      closed: this.#closed,
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#clearTimer();
    activeStorageKeys.delete(this.#storageKey);

    // Aborted rather than waited out. A request that will never answer — an offline machine, a
    // captive portal swallowing the connection — would otherwise hold `close()` for the full request
    // timeout, and on a page teardown there is not that long.
    this.#lifetime.abort(new Error('write client closed'));

    // `flush()` never rejects, so this cannot throw — but it is awaited rather than abandoned so a
    // Node caller can be sure nothing is still running when `close()` resolves.
    if (this.#inFlight !== null) await this.#inFlight;

    // The cycle's own `finally` re-arms, and it is guarded on `#closed` — this is belt and braces
    // against a timer armed between the flag being set and the cycle noticing.
    this.#clearTimer();
  }

  // -------------------------------------------------------------------------
  // Flushing
  // -------------------------------------------------------------------------

  async #cycle(): Promise<FlushResult> {
    try {
      return await this.#drain();
    } catch (error) {
      // Nothing in `#drain` is supposed to throw — `postRecords` classifies rather than rejecting —
      // so this is the "a bug in this client must not become an unhandled rejection" net. The timer
      // path `void`s this promise, and an unhandled rejection kills a Node process by default.
      this.#noteAttempt(false);
      this.#persist();
      this.#emit({
        type: 'flush_failed',
        reason: 'network',
        status: null,
        code: null,
        detail: error instanceof Error ? error.message : String(error),
        failures: this.#queue.failures,
        nextAttemptInMs: this.#nextDelayMs(),
      });
      return { acknowledged: 0, batches: 0, queued: this.#queue.size, ok: false };
    } finally {
      this.#inFlight = null;
      // In `finally`, so that a throw anywhere above — including one out of a consumer's callback
      // that got past its own guard — cannot leave the queue with no timer and nothing to restart it.
      this.#rearm();
    }
  }

  async #drain(): Promise<FlushResult> {
    this.#retryAfterMs = null;

    let acknowledged = 0;
    let batches = 0;
    let ok = true;

    while (batches < this.#maxBatchesPerFlush) {
      this.#reportEvictions(this.#queue.sweepAge(Date.now()));
      if (this.#queue.isEmpty) break;

      const batch = this.#queue.buildBatch();
      if (batch.length === 0) break;

      const disposition = await postRecords(
        this.#transport,
        batch.map((entry) => entry.wire),
        this.#lifetime.signal,
      );
      batches++;

      if (disposition.kind === 'results') {
        this.#settle(batch, disposition.results);
        this.#noteAttempt(true);
        this.#persist();
        acknowledged += batch.length;
        // Straight on to the next batch. Waiting for the next tick between batches would take three
        // minutes to drain 300 restored records — on a machine that reloads every three to five.
        continue;
      }

      ok = false;

      if (disposition.kind === 'drop') {
        const [only] = batch;
        this.#deliver(only.seq, {
          status: 'rejected',
          clientId: only.wire.client_id,
          error: disposition.code,
          message: disposition.detail,
        });
        this.#queue.remove(new Set([only.seq]));
        acknowledged += 1;
      }

      if (disposition.kind === 'retry' && disposition.retryAfterMs !== null) {
        this.#retryAfterMs = disposition.retryAfterMs;
      }

      this.#noteAttempt(false);
      this.#persist();

      this.#emit({
        type: 'flush_failed',
        reason: disposition.kind === 'drop' ? 'status' : disposition.reason,
        status: disposition.kind === 'drop' ? 413 : disposition.status,
        code: disposition.code,
        detail: disposition.detail,
        failures: this.#queue.failures,
        nextAttemptInMs: this.#nextDelayMs(),
      });
      break;
    }

    return { acknowledged, batches, queued: this.#queue.size, ok };
  }

  /**
   * Applies a batch's results.
   *
   * By index, because `results` is positionally aligned and deliberately not keyed by `client_id` —
   * a batch may legitimately carry the same one twice. And reported with *our* `client_id` rather
   * than the echoed one, which is `null` whenever the submitted id was unusable.
   *
   * All three verdicts remove the record: `created` stored it, `duplicate` means it was already
   * stored, and `rejected` means it will never be stored. Retrying any of them is what the protocol
   * calls a bug.
   */
  #settle(batch: readonly QueuedRecord[], results: readonly RecordResult[]): void {
    for (let i = 0; i < batch.length; i++) {
      const entry = results[i];
      const clientId = batch[i].wire.client_id;

      if (entry.status === 'rejected') {
        this.#deliver(batch[i].seq, { status: 'rejected', clientId, error: entry.error ?? null, message: entry.message });
      } else if (entry.status === 'created' || entry.status === 'duplicate') {
        this.#deliver(batch[i].seq, { status: entry.status, clientId });
      }
    }

    this.#queue.remove(new Set(batch.map((entry) => entry.seq)));
  }

  // -------------------------------------------------------------------------
  // Timer
  // -------------------------------------------------------------------------

  /**
   * Arms for a queue that was already there when this client was constructed.
   *
   * The delay honours "N seconds since the last attempt" *across the reload*, which is what the
   * persisted `lastAttemptAt` is for. The clamp is not decoration: a machine with a failing RTC can
   * report a `now` years away from the stored value, and the unclamped arithmetic then asks for a
   * delay of some hundreds of billions of milliseconds — a timer that never fires, on the one code
   * path whose entire job is to make sure something does.
   */
  #armForRestoredQueue(): void {
    if (this.#queue.isEmpty) return;

    const interval = this.#queue.failures > 0 ? this.#backoffMs(this.#queue.failures) : this.#flushIntervalMs;
    const last = this.#queue.lastAttemptAt;
    const delay = last === null ? 0 : clamp(last + interval - Date.now(), 0, interval);

    this.#arm(delay);
  }

  #rearm(): void {
    this.#clearTimer();
    if (this.#closed || this.#queue.isEmpty) return;
    this.#arm(this.#nextDelayMs());
  }

  #arm(delayMs: number): void {
    this.#clearTimer();
    // `ReturnType<typeof setTimeout>` because a browser hands back a number and Node a `Timeout`.
    // The handle is only ever passed to `clearTimeout`, and there is deliberately no `unref` —
    // letting a Node process exit while it still holds unsent records is the failure this avoids.
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.flush();
    }, delayMs);
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }

  /**
   * When to try next.
   *
   * One ladder, not two timers: a `Retry-After` wins if the service sent one, otherwise the backoff
   * delay while there are failures, otherwise the plain interval. Since the backoff ceiling is above
   * the interval, a long outage settles at the ceiling instead of retrying every minute.
   */
  #nextDelayMs(): number {
    if (this.#plannedDelayMs !== null) return this.#plannedDelayMs;

    const delay =
      this.#retryAfterMs !== null
        ? clamp(this.#retryAfterMs, 0, MAX_RETRY_AFTER_MS)
        : this.#queue.failures > 0
          ? this.#backoffMs(this.#queue.failures)
          : this.#flushIntervalMs;

    this.#plannedDelayMs = delay;
    return delay;
  }

  /** Records an attempt and invalidates the delay decided before it. */
  #noteAttempt(succeeded: boolean): void {
    this.#queue.noteAttempt(Date.now(), succeeded);
    this.#plannedDelayMs = null;
  }

  /** Exponential with equal jitter. The factor is 2 and is not an option; two knobs are enough. */
  #backoffMs(failures: number): number {
    const ceiling = Math.min(this.#backoffMaxMs, this.#backoffInitialMs * 2 ** (failures - 1));
    return Math.floor(ceiling / 2 + Math.random() * (ceiling / 2));
  }

  // -------------------------------------------------------------------------
  // Bookkeeping
  // -------------------------------------------------------------------------

  #persist(): void {
    const result = this.#queue.persist();
    this.#reportEvictions(result.evicted);

    if (!result.ok) {
      // Not thrown. A kiosk that throws out of `write()` inside a game's click handler is worse than
      // one that keeps running with a queue it can no longer mirror to disk: the records still in
      // memory are still sent, and only a reload loses them.
      this.#emit({
        type: 'storage_write_failed',
        detail: result.error instanceof Error ? result.error.message : String(result.error),
      });
    }
  }

  #reportEvictions(evictions: readonly { record: QueuedRecord; reason: EvictionReason }[]): void {
    if (evictions.length === 0) return;

    const counts = new Map<EvictionReason, number>();
    for (const { record, reason } of evictions) {
      this.#deliver(record.seq, { status: 'evicted', clientId: record.wire.client_id, reason });
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }

    for (const [reason, count] of counts) this.#emit({ type: 'records_evicted', reason, count });
  }

  /** Fires a record's callback at most once, and never lets it take the client down with it. */
  #deliver(seq: number, outcome: RecordOutcome): void {
    const callback = this.#callbacks.get(seq);
    if (callback === undefined) return;
    this.#callbacks.delete(seq);

    try {
      callback(outcome);
    } catch {
      // A consumer's callback is not this client's to police. Swallowing it here is what keeps one
      // bad handler from aborting a flush cycle and losing the timer with it.
    }
  }

  #emit(event: DiagnosticEvent): void {
    if (this.#onDiagnostic === undefined) return;
    try {
      this.#onDiagnostic(event);
    } catch {
      // As above.
    }
  }
}

/**
 * Creates a write client and starts draining whatever the last page left behind.
 *
 * Throws if another live client in this realm already holds the same `storageKey` — call `close()`
 * on the first one, or give this one its own key.
 *
 * At most one of these per key per origin, and cross-tab use is not supported: two tabs are two
 * in-memory queues mirroring to one key, and the loser's unsent records are overwritten. Nothing is
 * corrupted by it — `client_id` still dedupes everything that did get sent — but records can be
 * lost, so a kiosk should run one tab.
 */
export function createWriteClient(options: WriteClientOptions): WriteClient {
  return new WriteClientImpl(options);
}
