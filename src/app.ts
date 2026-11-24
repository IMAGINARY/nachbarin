/**
 * Routing, authentication, and the error boundary.
 *
 * This — not `index.ts` — is the entry point tests drive, because {@link Deps} is injected here.
 */

import { parseBearerToken } from './auth';
import { handleGetRecords, handlePostRecords } from './handlers';
import { describeError, fail, type LogFields } from './observability';
import { type Deps, StorageUnavailableError } from './storage';

const RECORDS_PATH = '/v1/records';
const RECORDS_ALLOW = 'GET, POST, OPTIONS';

/**
 * CORS, on every response. The first-class client is a kiosk browser running a page from
 * `http://localhost` or `file:`, which is never the Worker's origin. Without these headers the browser
 * blocks the POST, the client sees only a `NetworkError`, and it retries silently until the machine
 * powers off and the queue is lost. No test outside a browser can see that happen.
 *
 * `*` and not an allowlist, for two reasons:
 * - The credential is a bearer header, not a cookie. A page on any origin learns nothing without a
 *   key, and a page that has the key can use it from anywhere, curl included.
 * - A `file:` kiosk sends `Origin: null`, so an allowlist would have to admit `null`, which restricts
 *   nothing. The list would just be a per-venue setting to get wrong.
 *
 * `Retry-After` is exposed because it is not CORS-safelisted. Without the expose, the client's 503
 * backoff could not read it.
 */
const CORS_HEADERS: Readonly<Record<string, string>> = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'Retry-After',
};

/**
 * The preflight answer. `Authorization` and a JSON `Content-Type` are both non-simple, so every
 * cross-origin request preflights.
 *
 * 7200 s is Chromium's cap, and a longer value gets clamped. A cached preflight costs nothing; an
 * uncached one is an extra request and an extra log line.
 */
const PREFLIGHT_HEADERS: Readonly<Record<string, string>> = {
  'access-control-allow-methods': 'GET, POST',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-max-age': '7200',
};

/**
 * Handles one request end to end.
 *
 * The pipeline order is deliberate:
 *
 *   route (404/405, OPTIONS -> 204) -> authenticate (401/403) -> media type (415) -> read body (413)
 *   -> parse (400) -> validate (400) -> store (200/500/503)
 *
 * Routing precedes authentication so an unknown path 404s without needing a key; the API surface
 * is documented, so hiding it buys nothing. Authentication precedes reading the body so an
 * anonymous caller cannot make us buffer megabytes for free.
 *
 * Exactly one log line is emitted here, whatever happened — including for the failures below, which
 * stamp themselves onto the same object rather than logging separately. One request is one event:
 * the free plan allows 200k log events a day against a 100k request ceiling, and Cloudflare's own
 * invocation log already claims one of the two.
 */
export async function handleRequest(request: Request, deps: Deps): Promise<Response> {
  const log: LogFields = { event: 'request', method: request.method };
  const response = await routeCatching(request, deps, log);
  // Here rather than in each path, so that no path can leave it out: a 401 or 503 the browser
  // withholds from the client is as bad as a blocked 200. Every response is built with
  // `new Response`, so its headers can be changed.
  for (const [name, value] of Object.entries(CORS_HEADERS)) response.headers.set(name, value);

  log.status = response.status;
  // The level is the one thing derived rather than recorded: a 4xx is the protocol working, a 5xx is
  // ours to answer for. Everything finer is a query over the indexed `status` field.
  if (response.status >= 500) deps.log.error(log);
  else deps.log.info(log);

  return response;
}

/** {@link route} plus the error boundary. Total: every path returns a response, nothing rethrows. */
async function routeCatching(request: Request, deps: Deps, log: LogFields): Promise<Response> {
  try {
    return await route(request, deps, log);
  } catch (error) {
    Object.assign(log, describeError(error));

    if (error instanceof StorageUnavailableError) {
      // Retryable: the client should keep the batch queued and send it again. Idempotency via
      // client_id is what makes that safe. `error_name` is what carries the information here — the
      // message is a constant.
      return fail(log, 503, 'unavailable', error.message, { 'retry-after': '30' });
    }
    // Deliberately no message: internals must not reach the client. The log line is where they go,
    // and it is the only place they are allowed — see the never-log principle in `observability.ts`,
    // which explains why error text is not automatically free of visitor data.
    return fail(log, 500, 'internal_error');
  }
}

async function route(request: Request, deps: Deps, log: LogFields): Promise<Response> {
  const url = new URL(request.url);

  // Path first, then method. Switching on both at once would answer 404 for `DELETE /v1/records`,
  // which is wrong — that resource exists, the method just isn't allowed on it. No trailing-slash
  // normalization either: these clients are configured once, so a loud 404 at integration time
  // beats two permanently valid spellings of the same URL.
  if (url.pathname !== RECORDS_PATH) {
    return fail(log, 404, 'not_found', 'unknown endpoint');
  }

  // Before authentication, because a browser never attaches credentials to a preflight.
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: PREFLIGHT_HEADERS });
  }

  if (request.method !== 'GET' && request.method !== 'POST') {
    return fail(log, 405, 'method_not_allowed', `allowed methods: ${RECORDS_ALLOW}`, {
      allow: RECORDS_ALLOW,
    });
  }

  const token = parseBearerToken(request.headers.get('authorization'));
  if (token === null) return unauthorized(log);

  const principal = await deps.keyStore.resolve(token);
  // Unknown and revoked keys are indistinguishable here, and must stay that way.
  if (principal === null) return unauthorized(log);

  // Everything the log can say about who this is. The presented key is not among it: it is the
  // credential itself, and `keyId` is the handle the submission log already uses instead.
  log.app_id = principal.appId;
  log.instance_id = principal.instanceId;
  log.key_id = principal.keyId;
  log.key_kind = principal.kind;

  if (request.method === 'POST') {
    if (principal.kind !== 'write') {
      return fail(log, 403, 'forbidden', 'this key may not write records');
    }
    return handlePostRecords(request, principal, deps, log);
  }

  if (principal.kind !== 'read') {
    return fail(log, 403, 'forbidden', 'this key may not read records');
  }
  return handleGetRecords(url, principal, deps, log);
}

/** 401 means "I don't know who you are"; 403 means "I know, and you may not do this". */
function unauthorized(log: LogFields): Response {
  return fail(log, 401, 'unauthorized', 'a valid Bearer key is required', {
    'www-authenticate': 'Bearer',
  });
}
