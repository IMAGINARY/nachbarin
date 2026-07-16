/**
 * Endpoint handlers for `/v1/records`.
 *
 * Both take an already-authenticated principal and an injected {@link Deps}, so they are testable
 * without a database and without the Worker entry point.
 */

import type { WritePrincipal } from './auth';
import { MAX_REQUEST_BODY_BYTES, MAX_RESPONSE_BYTES } from './config';
import { errorResponse, isJsonContentType, jsonResponse, readCappedText } from './http';
import type { Deps, InsertOutcome, NewRecord, StoredRecord } from './storage';
import { validateReadQuery, validateRecord, validateWriteEnvelope } from './validation';

/** One entry of a write response. Always positionally aligned with the submitted record. */
interface RecordResult {
  /**
   * Echoed back for readability, not as a key — see {@link handlePostRecords}. Null when the
   * submitted `client_id` was itself unusable, which is the only reason it can be null.
   */
  client_id: string | null;
  status: 'created' | 'duplicate' | 'rejected';
  error?: string;
  message?: string;
}

const encoder = new TextEncoder();

/**
 * `POST /v1/records` — ingest a batch of records from one installation.
 *
 * ```
 * POST /v1/records
 * Authorization: Bearer <write-key>
 * Content-Type: application/json
 *
 * { "records": [ {
 *     "client_id": "3f8a…",                       // UUID, required — the idempotency key
 *     "created_at": "2026-07-15T14:03:22+02:00",  // RFC 3339 with offset, required
 *     "engine_version": "engine-1.4.2",           // string, required
 *     "content_version": "sha256:ab12…",          // string, optional
 *     "app_data": { … }                           // any JSON value, required, opaque
 * } ] }
 * ```
 *
 * Responds 200 whenever the *request* is well-formed; the fate of each individual record is
 * reported in `results`:
 *
 * ```
 * { "results": [
 *     { "client_id": "3f8a…", "status": "created" },
 *     { "client_id": "9c01…", "status": "duplicate" },
 *     { "client_id": "77de…", "status": "rejected",
 *       "error": "payload_too_large", "message": "…" }
 * ] }
 * ```
 *
 * The batch shape exists because clients queue records while offline and flush the queue later.
 * Per-record results let a flush partially succeed: the client drops everything acknowledged as
 * `created` **or** `duplicate` and retries only the rest. A duplicate is an acknowledgment, not an
 * error — to a client that is retrying because it never heard back, it means exactly "we have it".
 *
 * `results` is **positionally aligned** with the submitted `records` — same length, same order.
 * It is deliberately not keyed by `client_id`: nothing stops a batch from carrying the same
 * `client_id` twice, so a client keying by it would silently drop an entry. Position is the only
 * total mapping.
 *
 * No app or instance field is read from the body. Identity comes from the API key alone, so a
 * client cannot misreport who it is.
 */
export async function handlePostRecords(request: Request, principal: WritePrincipal, deps: Deps): Promise<Response> {
  if (!isJsonContentType(request.headers.get('content-type'))) {
    return errorResponse(415, 'unsupported_media_type', 'Content-Type must be application/json');
  }

  const body = await readCappedText(request, MAX_REQUEST_BODY_BYTES);
  if (!body.ok) {
    return body.reason === 'too_large'
      ? errorResponse(413, 'payload_too_large', `request body exceeds ${String(MAX_REQUEST_BODY_BYTES)} bytes`)
      : errorResponse(400, 'invalid_json', 'request body is not valid UTF-8');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.text);
  } catch {
    return errorResponse(400, 'invalid_json', 'request body is not valid JSON');
  }

  const envelope = validateWriteEnvelope(parsed);
  if (!envelope.ok) return errorResponse(400, envelope.error.code, envelope.error.message);

  // Validate everything first, so a rejected record never reaches storage and the store only ever
  // sees records it can actually persist.
  const results: RecordResult[] = [];
  const accepted: NewRecord[] = [];
  const acceptedIndices: number[] = [];

  envelope.value.forEach((raw, index) => {
    const record = validateRecord(raw);
    if (record.ok) {
      results.push({ client_id: record.value.clientId, status: 'created' });
      accepted.push(record.value);
      acceptedIndices.push(index);
      return;
    }
    // client_id is validated before every other field, so a null echo here means the client_id
    // itself was unusable — never that we lost a valid one while failing on something else.
    results.push({
      client_id: readClientId(raw),
      status: 'rejected',
      error: record.error.code,
      message: record.error.message,
    });
  });

  if (accepted.length > 0) {
    // A single timestamp for the whole batch. Workers freezes the clock during synchronous
    // execution anyway, so per-record calls would return identical values regardless.
    const outcomes: InsertOutcome[] = await deps.recordStore.insert(principal, deps.now(), accepted);
    outcomes.forEach((outcome, i) => {
      results[acceptedIndices[i]].status = outcome;
    });
  }

  return jsonResponse({ results });
}

/** Recovers a `client_id` worth echoing from a record that failed validation. */
function readClientId(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value: unknown = (raw as Record<string, unknown>).client_id;
  // Only echo a string. Echoing a raw invalid value would make the response field polymorphic and
  // break any client that parses it as a string.
  return typeof value === 'string' ? value : null;
}

/**
 * `GET /v1/records` — incremental bulk download.
 *
 * ```
 * GET /v1/records?after_id=184002&limit=1000
 *               [&app=…][&instance=…]
 *               [&engine_version=…][&content_version=…]
 * Authorization: Bearer <read-key>
 *
 * { "records": [ …full stored records, including id and received_at… ],
 *   "next_after_id": 185002,
 *   "has_more": true }
 * ```
 *
 * The cursor is the autoincrement `id` rather than a timestamp: unambiguous, collision-free, and
 * trivially resumable. `after_id` is an exclusive lower bound and defaults to 0, so
 * `next_after_id` is always a number — on an empty page it echoes the cursor you passed in.
 *
 * **Clients must not treat `records.length < limit` as end-of-stream.** Only `has_more: false`
 * means the download is complete. A page may be short because it hit the response byte budget,
 * and that is a normal, expected occurrence rather than an error.
 */
export async function handleGetRecords(url: URL, deps: Deps): Promise<Response> {
  const query = validateReadQuery(url.searchParams);
  if (!query.ok) return errorResponse(400, query.error.code, query.error.message);

  const page = await deps.recordStore.list(query.value);
  const { records, hasMore } = trimToByteBudget(page.records, page.hasMore);

  const lastId = records.length > 0 ? records[records.length - 1].id : query.value.afterId;

  return jsonResponse({ records, next_after_id: lastId, has_more: hasMore });
}

/**
 * Truncates a page to {@link MAX_RESPONSE_BYTES}.
 *
 * A full page of max-size records would be 64MB against a 128MB per-isolate budget that is shared
 * across concurrently executing requests. Returning fewer records is safe precisely because the
 * cursor contract makes a short page indistinguishable from any other: the client follows
 * `next_after_id` and `has_more` and simply comes back for the rest.
 *
 * This caps the response, not peak memory — the rows are already materialized by the time we get
 * here. Pushing the budget down into the query is the real fix and belongs with the adapter.
 */
function trimToByteBudget(
  records: readonly StoredRecord[],
  hasMore: boolean,
): { records: readonly StoredRecord[]; hasMore: boolean } {
  let total = 0;

  for (let i = 0; i < records.length; i++) {
    total += encoder.encode(JSON.stringify(records[i])).byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      // Always keep at least one record, or a single oversized row would stall the cursor forever.
      const kept = i === 0 ? 1 : i;
      return { records: records.slice(0, kept), hasMore: true };
    }
  }

  return { records, hasMore };
}
