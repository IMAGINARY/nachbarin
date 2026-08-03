/**
 * The three ways this client fails.
 *
 * They are distinct because callers act on them differently: a {@link ValidationError} is a bug in
 * the calling code and is thrown synchronously from `write()`; an {@link ApiError} is the service
 * saying no; a {@link TransportError} is the network, and says nothing about the service at all.
 *
 * `name` is assigned explicitly on each. A consumer's minifier is free to rename the class, and
 * `err.name` is what survives into a log line.
 *
 * None of these ever carries the API key. That is not enforced by anything but this sentence and a
 * spec — the key is only ever put in a header, never in a URL or a message, so there is nothing to
 * redact.
 */

import type { ErrorCode } from './protocol';

/**
 * The service returned a non-2xx response.
 *
 * `code` is `null` when the body was not a JSON object with an `error` field — a proxy's HTML error
 * page, a captive portal, a gateway timeout. That distinction matters: a `code` means the service
 * spoke, and `null` means something in between did.
 */
export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly status: number;
  readonly code: ErrorCode | null;
  /** `Retry-After`, in milliseconds, when the response carried a parseable one. */
  readonly retryAfterMs: number | null;

  constructor(status: number, code: ErrorCode | null, message: string, retryAfterMs: number | null = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * The request never got an answer: DNS, TLS, CORS, an offline machine, or our own timeout.
 *
 * Always retryable, and — for the write client — never a reason to drop anything. `cause` carries
 * the underlying `fetch` rejection or `AbortError`.
 */
export class TransportError extends Error {
  override readonly name = 'TransportError';
  /** True when this client's own request timeout fired, rather than the network failing. */
  readonly timedOut: boolean;

  constructor(message: string, options: { cause?: unknown; timedOut?: boolean } = {}) {
    super(message, { cause: options.cause });
    this.timedOut = options.timedOut ?? false;
  }
}

/**
 * A record that the service could never accept, caught before it entered the queue.
 *
 * Thrown synchronously from `write()` rather than reported through `onResult`, because `onResult` is
 * best-effort and may never fire — a producer bug delivered only through it could be lost entirely
 * across a page reload. A throw cannot be lost.
 */
export class ValidationError extends Error {
  override readonly name = 'ValidationError';
  /** The offending field, named as it appears on the wire (`app_data`, not `appData`). */
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.field = field;
  }
}
