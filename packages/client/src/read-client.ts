/**
 * The read client: download this installation's records, incrementally.
 *
 * Its retry policy is deliberately the opposite of the write client's, and the reason is who is
 * holding the key. **The write client never gives up, because there is nobody to tell; the read
 * client gives up quickly, because there is somebody to tell.** A write key sits in an unattended
 * kiosk where a thrown error is a lost record. A read key is being used by a person or a script they
 * are watching, and a call that silently retried an expired credential for an hour would be worse
 * than one that failed in three seconds.
 *
 * There is no `app` or `instance` parameter, here or anywhere. A read key grants exactly one
 * installation, and scope is authorization rather than a filter — so there is nothing to pass. Full
 * corpus export across installations is an operator's SQL query on purpose, not an API capability.
 */

import { ApiError, TransportError } from './errors';
import type { RecordPage, StoredRecord } from './protocol';
import { getRecords, type ListParams, normalizeBaseUrl, type Transport } from './transport';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_READ_RETRIES = 2;

/** A person is waiting, so an honoured `Retry-After` is capped hard. */
const MAX_READ_RETRY_DELAY_MS = 5_000;

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

export interface ReadClientOptions {
  /** Service root, e.g. `https://nachbarin.example.workers.dev`. A path prefix is preserved. */
  readonly baseUrl: string;
  /** A `read` API key. The installation it covers is a property of the key. */
  readonly apiKey: string;
  /** Transport injection point. Pass it bound — see `WriteClientOptions.fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  readonly requestTimeoutMs?: number;
  /** Extra attempts on a retryable failure, per page. Default 2, i.e. three attempts in all. */
  readonly readRetries?: number;
}

export interface ReadClient {
  /** One page. Throws `ApiError` on a refusal, `TransportError` when the request never landed. */
  list(params?: ListParams): Promise<RecordPage>;
  /**
   * Every record from `afterId` onward, walking pages until the service says there are no more.
   *
   * `limit` applies per page, not to the total. Breaking out of the loop stops fetching.
   */
  listAll(params?: ListParams): AsyncIterableIterator<StoredRecord>;
}

function isRetryable(error: unknown): boolean {
  if (error instanceof TransportError) return true;
  // status 0 is this client's own argument check, which no retry can fix.
  return error instanceof ApiError && error.status !== 0 && RETRYABLE_STATUSES.has(error.status);
}

function retryDelayMs(error: unknown, attempt: number): number {
  const suggested = error instanceof ApiError ? error.retryAfterMs : null;
  const backoff = Math.min(MAX_READ_RETRY_DELAY_MS, 250 * 2 ** attempt);
  return Math.min(MAX_READ_RETRY_DELAY_MS, suggested ?? backoff);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    function onAbort(): void {
      clearTimeout(timer);
      // The caller's own abort reason, verbatim and whatever it is. `AbortSignal.reason` is not
      // required to be an `Error` — `abort('changed my mind')` is legal — and substituting one here
      // would hide from the caller the thing they themselves passed.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      reject(signal?.reason);
    }

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

class ReadClientImpl implements ReadClient {
  readonly #transport: Transport;
  readonly #retries: number;

  constructor(options: ReadClientOptions) {
    this.#transport = {
      baseUrl: normalizeBaseUrl(options.baseUrl),
      apiKey: options.apiKey,
      fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
      timeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    };
    this.#retries = Math.max(0, options.readRetries ?? DEFAULT_READ_RETRIES);
  }

  async list(params: ListParams = {}): Promise<RecordPage> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.#retries; attempt++) {
      try {
        return await getRecords(this.#transport, params);
      } catch (error) {
        lastError = error;
        // Every 4xx throws straight out: a bad key, a bad cursor and a wrong key kind are all things
        // that retrying cannot change, and the caller is right there to be told.
        if (!isRetryable(error) || attempt === this.#retries) throw error;
        await sleep(retryDelayMs(error, attempt), params.signal);
      }
    }

    throw lastError;
  }

  async *listAll(params: ListParams = {}): AsyncIterableIterator<StoredRecord> {
    let afterId = params.afterId ?? 0;

    for (;;) {
      const page = await this.list({ ...params, afterId });

      for (const record of page.records) yield record;

      // Only `has_more` ends the walk. A short page is normal — the service truncates to a response
      // byte budget — and treating `records.length < limit` as the end would silently stop a
      // download partway through while reporting success.
      if (!page.has_more) return;

      // A cursor that does not advance while claiming there is more would spin forever, re-fetching
      // one page and yielding nothing. That is a service bug rather than a state to tolerate, and an
      // infinite loop is the worst possible way to report it.
      if (page.next_after_id <= afterId) {
        throw new ApiError(200, null, `the cursor did not advance past ${String(afterId)} while has_more was true`);
      }

      afterId = page.next_after_id;
    }
  }
}

export function createReadClient(options: ReadClientOptions): ReadClient {
  return new ReadClientImpl(options);
}
