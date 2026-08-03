/**
 * Structured logging for Workers Logs.
 *
 * Named for Cloudflare's product and for the `observability` key in `wrangler.jsonc`, and
 * deliberately *not* `log.ts`: in this repo "the log" already means `record_submissions`, read
 * through `scripts/commands/log.ts`. Two things called the log is how a question gets answered from
 * the wrong one.
 *
 * **Every call passes exactly one object.** Workers Logs extracts and indexes the fields of a lone
 * object argument; `console.log('msg', { a: 1 })` stores the pair as an array and indexes nothing,
 * so `a` becomes unfilterable and the value is only findable by text match. That is the entire
 * reason this module exists, and it is why `no-console` is on for the rest of `src/` — this file is
 * the only exemption.
 *
 * ## What may go in one of these objects
 *
 * The rule is need-to-know, the same principle `record_submissions` is built on, and it has two
 * halves:
 *
 * - **Never the visitor payload.** No `app_data`, no request body, no `client_id`. Nothing from
 *   `Provenance` except `submissionId` — no IP, user agent, city, ASN, timezone or colo. Those
 *   belong in `record_submissions`, which no API key can read and which expires at
 *   `METADATA_RETENTION_DAYS`; a log line has neither of those properties.
 * - **Nothing Cloudflare already records.** An invocation log accompanies every request with the
 *   method, full URL, status, outcome, CPU and wall time. Restating those spends the log-event
 *   budget to say what is already on the adjacent row.
 *
 * The first half is a *principle and not a list of field names*, because the sharpest case does not
 * look like one. V8 embeds the first ~10 characters of its input in a `JSON.parse` error message,
 * verbatim — `JSON.parse('canary-visitor-data')` throws `Unexpected token 'c', "canary-vis"... is
 * not valid JSON` — and `d1-record-store.ts` parses `app_data` uncaught on the read path. So an
 * internal error string is not automatically free of visitor data, and no rule phrased over
 * variable names would catch it. {@link clamp} bounds the damage; it cannot prevent it, since the
 * leaked characters come first. Logging error text anyway is a deliberate trade: a 500 nobody can
 * diagnose is the worse outcome, and these logs live 3–7 days behind the same credentials as the
 * database itself.
 */

import { type ErrorCode, errorResponse } from './http';

/** The kinds of event this Worker emits. Closed, so `docs/observability.md`'s table is checkable. */
export type LogEvent = 'request' | 'retention_sweep' | 'unmappable_key_row';

/**
 * The sink. An interface rather than a direct `console` call so `Deps` can inject it, which is what
 * lets `test/logging.spec.ts` assert what a request logged — including that it logged no payload.
 *
 * Two levels only. Severity beyond "did this need a human" is what the indexed `status` field is
 * for.
 */
export interface Logger {
  info(fields: Readonly<Record<string, unknown>>): void;
  error(fields: Readonly<Record<string, unknown>>): void;
}

export const consoleLogger: Logger = {
  // One argument each, per the module comment. Adding a second would silently unindex every field.
  info: (fields) => {
    console.log(fields);
  },
  error: (fields) => {
    console.error(fields);
  },
};

/**
 * One request's log line, accumulated as it is served and emitted once at the boundary.
 *
 * Mutable and almost entirely optional, which is the point: a field is present when some stage of
 * the pipeline actually learned it. A 401 never learns an installation; an all-rejected batch never
 * mints a submission id. Absent means "this path did not get that far", and that is information —
 * so nothing here is defaulted to zero.
 *
 * snake_case to match `StoredRecord` and the SQL columns these fields correspond to, so one spelling
 * of `app_id` works across the wire, the database and the logs.
 *
 * A `type` and not an `interface`, which is load-bearing: only the former carries an implicit index
 * signature, and without one this does not satisfy {@link Logger}'s parameter.
 */
export type LogFields = {
  readonly event: 'request';
  readonly method: string;
  status?: number;
  /** The machine-readable code from the error body. Set for every response the client sees as a failure. */
  error?: ErrorCode;

  // Identity, once the key resolves. Not derivable from anything in the invocation log.
  app_id?: string;
  instance_id?: string;
  key_id?: number;
  key_kind?: 'read' | 'write';

  // POST. Absent on a request that never reached the handler.
  /**
   * Joins this line to its `record_submissions` rows. Absent when the batch stored nothing — an
   * empty or wholly rejected batch mints no submission id, because it writes no log rows to join to.
   */
  submission_id?: string;
  created?: number;
  duplicate?: number;
  rejected?: number;
  /**
   * Rejection counts by code, e.g. `{ invalid_field: 3 }`. Overlaps {@link rejected} on purpose: the
   * scalar is what you notice, the histogram is what tells you which client is broken and how.
   */
  rejections?: Partial<Record<ErrorCode, number>>;

  // GET.
  returned?: number;
  has_more?: boolean;
  /**
   * Whether the response byte budget truncated the page (`trimToByteBudget` in `handlers.ts`).
   * Otherwise invisible: a truncated page is indistinguishable from any other short page by design,
   * which is exactly why the fact belongs here instead.
   */
  truncated?: boolean;

  // 5xx/503 only. See the module comment on why these are bounded rather than trusted.
  error_name?: string;
  error_message?: string;
  stack?: string;
};

/**
 * An error response that records its own code on the request's log line.
 *
 * Every failure in the request path goes through here, so the `error` field cannot drift from the
 * body the client actually received. Recovering the code from the finished `Response` instead — by
 * parsing the body back, or by keying a side table on the object's identity — would work today and
 * break silently the first time anything wraps a response on its way out.
 *
 * It lives beside the log rather than beside {@link errorResponse} because the stamping is the whole
 * point; the delegation is incidental.
 */
export function fail(log: LogFields, status: number, code: ErrorCode, message?: string, headers?: Record<string, string>): Response {
  log.error = code;
  return errorResponse(status, code, message, headers);
}

/**
 * The bound on any string derived from a thrown value.
 *
 * Generous enough for a stack that names the failing frame, small enough that a pathological error
 * cannot crowd out the rest of the invocation against the 256 KB per-request log ceiling.
 */
const MAX_ERROR_TEXT = 1024;

/** Truncates to {@link MAX_ERROR_TEXT}. Non-strings become undefined rather than `"[object Object]"`. */
function clamp(value: unknown): string | undefined {
  return typeof value === 'string' ? value.slice(0, MAX_ERROR_TEXT) : undefined;
}

/** The part of a log line that describes a thrown value. A subset of {@link LogFields}'s shape. */
interface ErrorDescription {
  error_name: string;
  error_message?: string;
  stack?: string;
}

/**
 * Describes a thrown value.
 *
 * Takes `unknown` because `throw` does: a non-`Error` still has to produce a legible line, and
 * `String(value)` is the only thing that works for every one of them.
 *
 * `stack` overlaps the other two — V8 starts a stack with `name: message` — and is kept because it
 * is the only one that says *where*. The other two are what stays legible when whatever was thrown
 * had no stack at all.
 */
export function describeError(error: unknown): ErrorDescription {
  if (error instanceof Error) {
    return { error_name: error.name, error_message: clamp(error.message), stack: clamp(error.stack) };
  }
  return { error_name: typeof error, error_message: clamp(String(error)) };
}
