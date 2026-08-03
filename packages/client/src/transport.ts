/**
 * Everything that touches the network, and the single place that decides what a response means.
 *
 * The classification in {@link postRecords} is the client's most consequential code, so it lives
 * here and nowhere else. Two rules drive all of it:
 *
 * **A 2xx is not success unless the body proves it.** A museum's guest wifi captive portal answers
 * `200 text/html` with a login page. Code that reads the status and drops the batch loses every
 * record in it, silently, at exactly the moment the network is least trustworthy. So success
 * requires a body that parses as JSON, is an object, carries a `results` array, and whose length
 * matches what was sent — anything else keeps every record.
 *
 * **A 4xx is not a reason to drop.** The service's own `KeyStore.resolve` refuses to turn a database
 * failure into a 401 precisely because a client must never conclude "my credential is bad" from an
 * outage. This is the other side of that: a 401 here means keep retrying, because the alternative —
 * discarding a day's records because a key rotation was briefly mid-flight — is unrecoverable, and
 * on hardware that is wiped nightly there is no upstream copy left to re-send. The single exception
 * is a 413 on a batch of one, and byte-aware batch building makes even that unreachable.
 */

import { ApiError, TransportError } from './errors';
import {
  type ErrorCode,
  type RecordPage,
  type RecordResult,
  RECORD_STATUSES,
  type StoredRecord,
  type WireRecord,
  READ_LIMIT_MAX,
} from './protocol';

const RECORDS_PATH = '/v1/records';
const JSON_CONTENT_TYPE = 'application/json';

export interface Transport {
  /** Normalized service root — origin plus any path prefix, no trailing slash. */
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetch: typeof globalThis.fetch;
  readonly timeoutMs: number;
}

/** Query parameters for a read. Mirrors `READ_QUERY_KEYS`; there is no `app` or `instance`. */
export interface ListParams {
  /** Exclusive lower bound on `id`. Omit or pass 0 to start from the beginning. */
  readonly afterId?: number;
  readonly limit?: number;
  readonly engineVersion?: string;
  readonly contentVersion?: string;
  readonly signal?: AbortSignal;
}

export type RetryReason = 'network' | 'timeout' | 'status' | 'protocol';

/**
 * What one POST meant.
 *
 * `results` is the only outcome that removes anything from the queue. `retry` keeps every record
 * without exception. `drop` exists for exactly one case and is spelled separately so that adding a
 * second is a deliberate edit rather than a new `if`.
 */
export type PostDisposition =
  | { readonly kind: 'results'; readonly results: readonly RecordResult[] }
  | {
      readonly kind: 'retry';
      readonly reason: RetryReason;
      readonly status: number | null;
      readonly code: ErrorCode | null;
      readonly detail: string;
      readonly retryAfterMs: number | null;
    }
  | { readonly kind: 'drop'; readonly code: ErrorCode | null; readonly detail: string };

/**
 * Origin plus path prefix, trailing slash stripped, query and fragment discarded.
 *
 * Not `.origin`: a service mounted at `https://api.museum.org/nachbarin/` would lose its prefix and
 * every request would 404 — a failure that looks exactly like a wrong key from the outside.
 *
 * Throws on a relative URL, which is the right moment to find out.
 */
export function normalizeBaseUrl(raw: string): string {
  const url = new URL(raw);
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

function authHeaders(apiKey: string): Record<string, string> {
  // RFC 9110: the scheme is case-insensitive, separated from the token by a space. The key never
  // appears anywhere else — not in a URL, not in a message — so no error from this package can leak
  // it, and none needs redacting.
  return { authorization: `Bearer ${apiKey}` };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads `signal.aborted` through a parameter rather than in place.
 *
 * A caller can abort at any point while the request is in flight, so the flag has to be re-read
 * after the `await`. Testing it inline instead would be narrowed by the check made before the
 * request started, and the compiler would — correctly, by its own rules — call the second test
 * unreachable.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}

/**
 * `Retry-After` in milliseconds, or `null`.
 *
 * Only the delta-seconds form is honoured; the HTTP-date form falls back to the caller's own ladder.
 * The service only ever sends seconds, and a date form here would most likely come from an
 * intermediary whose clock is not ours to trust.
 *
 * Callers clamp. The bound is a policy question and the two clients answer it differently.
 */
export function parseRetryAfterMs(header: string | null): number | null {
  if (header === null) return null;
  const trimmed = header.trim();
  if (!/^\d+$/.test(trimmed)) return null;

  const seconds = Number(trimmed);
  return Number.isSafeInteger(seconds) ? seconds * 1000 : null;
}

/**
 * One HTTP request, bounded by {@link Transport.timeoutMs}.
 *
 * The timeout is a `Promise.race` against a `setTimeout` *as well as* an `AbortController`, not
 * either alone. The controller is what actually frees the socket; the race is what guarantees this
 * function settles even if the injected `fetch` ignores the signal. And it is `AbortController`
 * rather than `AbortSignal.timeout()` because the latter is a host-internal timer that
 * `vi.useFakeTimers()` does not patch — which would leave the timeout path untestable, and an
 * untested timeout on unattended hardware is a hang.
 */
async function request(transport: Transport, url: string, init: RequestInit, external?: AbortSignal): Promise<Response> {
  if (isAborted(external)) throw (external as AbortSignal).reason;

  const controller = new AbortController();

  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  // The caller's abort is raced as well as forwarded, for the same reason the timeout is: an
  // injected `fetch` is under no obligation to honour a signal, and one that ignores it would leave
  // `break` out of `listAll` waiting for the timeout instead of returning.
  let rejectOnExternalAbort: ((reason: unknown) => void) | undefined;
  const externalAbort = new Promise<never>((_, reject) => {
    rejectOnExternalAbort = reject;
  });
  externalAbort.catch(() => undefined);

  const abortForExternal = (): void => {
    controller.abort();
    rejectOnExternalAbort?.(external?.reason);
  };
  external?.addEventListener('abort', abortForExternal);

  const attempt = transport.fetch(url, { ...init, signal: controller.signal });
  // Every race leaves losers pending. Without this, a rejection arriving after the race has already
  // settled is an unhandled rejection — which terminates a Node process by default.
  attempt.catch(() => undefined);

  const contenders: Promise<Response>[] = [
    attempt,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new TransportError(`request timed out after ${String(transport.timeoutMs)} ms`, { timedOut: true }));
      }, transport.timeoutMs);
    }),
  ];
  if (external !== undefined) contenders.push(externalAbort);

  try {
    return await Promise.race(contenders);
  } catch (error) {
    if (error instanceof TransportError) throw error;
    // A caller's own abort is theirs to see, verbatim — `break` out of `listAll` relies on it.
    if (isAborted(external)) throw error;
    throw new TransportError('the request could not be completed', { cause: error, timedOut });
  } finally {
    clearTimeout(timer);
    external?.removeEventListener('abort', abortForExternal);
  }
}

async function readBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    throw new TransportError('the response body could not be read', { cause: error });
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Best-effort `{ error, message }` extraction. Both `null` when something other than the service answered. */
function readErrorBody(text: string): { readonly code: ErrorCode | null; readonly message: string | null } {
  const body = parseJson(text);
  if (!isObject(body)) return { code: null, message: null };

  const code = typeof body.error === 'string' ? (body.error as ErrorCode) : null;
  const message = typeof body.message === 'string' ? body.message : null;
  return { code, message };
}

function describe(status: number, code: ErrorCode | null, message: string | null): string {
  const codePart = code === null ? '' : ` ${code}`;
  const messagePart = message === null ? '' : `: ${message}`;
  return `HTTP ${String(status)}${codePart}${messagePart}`;
}

/**
 * Validates a write response, returning `null` if it is not one.
 *
 * The length check is the important one and it is not a formality. `results` is positionally aligned
 * with what was sent, so a mismatched length means no result can be attributed to any record.
 * Guessing would drop the wrong ones; retrying the whole batch is free, because `client_id` makes it
 * idempotent and the worst case is every record coming back `duplicate`.
 */
function readWriteResponse(text: string, sent: number): readonly RecordResult[] | null {
  const body = parseJson(text);
  if (!isObject(body)) return null;

  const { results } = body;
  if (!Array.isArray(results) || results.length !== sent) return null;

  for (const entry of results) {
    if (!isObject(entry)) return null;
    if (typeof entry.status !== 'string' || !(RECORD_STATUSES as readonly string[]).includes(entry.status)) return null;
    if (entry.client_id !== null && typeof entry.client_id !== 'string') return null;
  }

  return results as readonly RecordResult[];
}

/**
 * Submits a batch and classifies the answer. **Never throws** — every failure becomes a disposition.
 *
 * That is what lets `flush()` keep its own promise never to reject, which in turn is what makes it
 * safe for the timer to `void` it.
 */
export async function postRecords(transport: Transport, batch: readonly WireRecord[], signal?: AbortSignal): Promise<PostDisposition> {
  let response: Response;
  let text: string;

  try {
    response = await request(
      transport,
      `${transport.baseUrl}${RECORDS_PATH}`,
      {
        method: 'POST',
        headers: { ...authHeaders(transport.apiKey), 'content-type': JSON_CONTENT_TYPE },
        body: JSON.stringify({ records: batch }),
      },
      signal,
    );
    text = await readBody(response);
  } catch (error) {
    const timedOut = error instanceof TransportError && error.timedOut;
    return {
      kind: 'retry',
      reason: timedOut ? 'timeout' : 'network',
      status: null,
      code: null,
      detail: error instanceof Error ? error.message : 'the request could not be completed',
      retryAfterMs: null,
    };
  }

  if (response.ok) {
    const results = readWriteResponse(text, batch.length);
    if (results !== null) return { kind: 'results', results };

    return {
      kind: 'retry',
      reason: 'protocol',
      status: response.status,
      code: null,
      detail: `HTTP ${String(response.status)} did not carry a write response for ${String(batch.length)} record(s)`,
      retryAfterMs: null,
    };
  }

  const { code, message } = readErrorBody(text);
  const detail = describe(response.status, code, message);

  // The one drop rule. A batch of one that is too large cannot be split, so no retry can ever change
  // the answer — this is the only 4xx that is genuinely terminal for a record rather than for an
  // attempt. Pre-validation caps `app_data` well below the body limit, so reaching this means the
  // service tightened a limit under a running client, which is exactly when it must not spin.
  if (response.status === 413 && batch.length === 1) {
    return { kind: 'drop', code, detail };
  }

  return {
    kind: 'retry',
    reason: 'status',
    status: response.status,
    code,
    detail,
    retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')),
  };
}

function isStoredRecord(value: unknown): value is StoredRecord {
  if (!isObject(value)) return false;
  return (
    typeof value.id === 'number' &&
    typeof value.app_id === 'string' &&
    typeof value.instance_id === 'string' &&
    typeof value.client_id === 'string' &&
    typeof value.created_date === 'string' &&
    typeof value.received_date === 'string' &&
    typeof value.engine_version === 'string' &&
    (value.content_version === null || typeof value.content_version === 'string') &&
    'app_data' in value
  );
}

function buildListUrl(transport: Transport, params: ListParams): string {
  const url = new URL(`${transport.baseUrl}${RECORDS_PATH}`);

  // Only what the caller asked for. Unknown *and* repeated parameters are hard 400s at the service,
  // so this builds the query rather than merging one.
  if (params.afterId !== undefined && params.afterId > 0) url.searchParams.set('after_id', String(params.afterId));
  if (params.limit !== undefined) url.searchParams.set('limit', String(params.limit));
  if (params.engineVersion !== undefined) url.searchParams.set('engine_version', params.engineVersion);
  if (params.contentVersion !== undefined) url.searchParams.set('content_version', params.contentVersion);

  return url.toString();
}

/**
 * Fetches one page. Throws {@link ApiError} on a refusal and {@link TransportError} on a network
 * failure — the read client is driven by a person, so it says so rather than retrying forever.
 */
export async function getRecords(transport: Transport, params: ListParams): Promise<RecordPage> {
  if (params.afterId !== undefined && (!Number.isSafeInteger(params.afterId) || params.afterId < 0)) {
    throw new ApiError(0, null, 'afterId must be a non-negative safe integer');
  }
  if (params.limit !== undefined && (!Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > READ_LIMIT_MAX)) {
    throw new ApiError(0, null, `limit must be an integer between 1 and ${String(READ_LIMIT_MAX)}`);
  }

  const response = await request(
    transport,
    buildListUrl(transport, params),
    { method: 'GET', headers: authHeaders(transport.apiKey) },
    params.signal,
  );
  const text = await readBody(response);

  if (!response.ok) {
    const { code, message } = readErrorBody(text);
    throw new ApiError(
      response.status,
      code,
      describe(response.status, code, message),
      parseRetryAfterMs(response.headers.get('retry-after')),
    );
  }

  const body = parseJson(text);
  if (
    !isObject(body) ||
    !Array.isArray(body.records) ||
    typeof body.next_after_id !== 'number' ||
    typeof body.has_more !== 'boolean' ||
    !body.records.every(isStoredRecord)
  ) {
    // Same rule as the write path: a 2xx that does not carry the documented shape did not come from
    // this service. Saying so beats handing back a page-shaped object with nothing in it.
    throw new ApiError(response.status, null, `HTTP ${String(response.status)} did not carry a record page`);
  }

  return { records: body.records, next_after_id: body.next_after_id, has_more: body.has_more };
}
