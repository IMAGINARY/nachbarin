/**
 * HTTP plumbing: response construction, content negotiation, and bounded body reading.
 */

/**
 * Machine-readable failure codes.
 *
 * `error` is always one of these, at the top level and inside a per-record result alike. Human
 * prose lives in a separate `message` field, so clients branch on a stable code and messages stay
 * free to be reworded.
 */
export type ErrorCode =
  | 'invalid_json'
  | 'invalid_request'
  | 'invalid_field'
  | 'batch_too_large'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'method_not_allowed'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'internal_error'
  | 'unavailable';

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': JSON_CONTENT_TYPE, ...headers },
  });
}

export function errorResponse(status: number, error: ErrorCode, message?: string, headers: Record<string, string> = {}): Response {
  return jsonResponse(message === undefined ? { error } : { error, message }, status, headers);
}

/** True if the media type is exactly `application/json`. Parameters (`; charset=…`) are ignored. */
export function isJsonContentType(header: string | null): boolean {
  if (header === null) return false;
  const mediaType = header.split(';', 1)[0].trim().toLowerCase();
  return mediaType === 'application/json';
}

export type BodyReadResult =
  { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: 'too_large' | 'invalid_utf8' };

/**
 * Reads a request body as text, refusing to buffer more than `maxBytes`.
 *
 * `Content-Length` is only a fast path — it can be absent under chunked encoding and it can lie,
 * so the streaming byte counter is what actually enforces the cap.
 *
 * Decoding is strict: invalid UTF-8 fails the request rather than being silently substituted with
 * U+FFFD, which would persist corrupted text under the guise of a successful write.
 */
export async function readCappedText(request: Request, maxBytes: number): Promise<BodyReadResult> {
  const declared = request.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    return { ok: false, reason: 'too_large' };
  }

  // workerd types the body as `ReadableStream<any>`; a request body always yields byte chunks, and
  // naming that keeps `read()`'s discriminated union narrowing `value` properly.
  const body = request.body as ReadableStream<Uint8Array> | null;
  if (body === null) return { ok: true, text: '' };

  // `ignoreBOM: false` strips a leading BOM (the name is inverted), so a client that emits one
  // still parses rather than choking on a stray U+FEFF.
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  const reader = body.getReader();
  let total = 0;
  let text = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return { ok: false, reason: 'too_large' };
    }

    try {
      text += decoder.decode(value, { stream: true });
    } catch {
      await reader.cancel();
      return { ok: false, reason: 'invalid_utf8' };
    }
  }

  try {
    // Flushes any trailing partial code point, which is itself an error under `fatal`.
    text += decoder.decode();
  } catch {
    return { ok: false, reason: 'invalid_utf8' };
  }

  return { ok: true, text };
}
