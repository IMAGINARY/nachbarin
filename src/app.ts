/**
 * Routing, authentication, and the error boundary.
 *
 * This — not `index.ts` — is the entry point tests drive, because {@link Deps} is injected here.
 */

import { parseBearerToken } from './auth';
import { handleGetRecords, handlePostRecords } from './handlers';
import { errorResponse } from './http';
import { type Deps, StorageUnavailableError } from './storage';

const RECORDS_PATH = '/v1/records';
const RECORDS_ALLOW = 'GET, POST';

/**
 * Handles one request end to end.
 *
 * The pipeline order is deliberate:
 *
 *   route (404/405) -> authenticate (401/403) -> media type (415) -> read body (413)
 *   -> parse (400) -> validate (400) -> store (200/500/503)
 *
 * Routing precedes authentication so an unknown path 404s without needing a key; the API surface
 * is documented, so hiding it buys nothing. Authentication precedes reading the body so an
 * anonymous caller cannot make us buffer megabytes for free.
 */
export async function handleRequest(request: Request, deps: Deps): Promise<Response> {
  try {
    return await route(request, deps);
  } catch (error) {
    if (error instanceof StorageUnavailableError) {
      // Retryable: the client should keep the batch queued and send it again. Idempotency via
      // client_id is what makes that safe.
      return errorResponse(503, 'unavailable', error.message, { 'retry-after': '30' });
    }
    console.error('unhandled error while serving request', error);
    // Deliberately no message: internals must not reach the client.
    return errorResponse(500, 'internal_error');
  }
}

async function route(request: Request, deps: Deps): Promise<Response> {
  const url = new URL(request.url);

  // Path first, then method. Switching on both at once would answer 404 for `DELETE /v1/records`,
  // which is wrong — that resource exists, the method just isn't allowed on it. No trailing-slash
  // normalization either: these clients are configured once, so a loud 404 at integration time
  // beats two permanently valid spellings of the same URL.
  if (url.pathname !== RECORDS_PATH) {
    return errorResponse(404, 'not_found', 'unknown endpoint');
  }

  if (request.method !== 'GET' && request.method !== 'POST') {
    return errorResponse(405, 'method_not_allowed', `allowed methods: ${RECORDS_ALLOW}`, {
      allow: RECORDS_ALLOW,
    });
  }

  const token = parseBearerToken(request.headers.get('authorization'));
  if (token === null) return unauthorized();

  const principal = await deps.keyStore.resolve(token);
  // Unknown and revoked keys are indistinguishable here, and must stay that way.
  if (principal === null) return unauthorized();

  if (request.method === 'POST') {
    if (principal.kind !== 'write') {
      return errorResponse(403, 'forbidden', 'this key may not write records');
    }
    return handlePostRecords(request, principal, deps);
  }

  if (principal.kind !== 'read') {
    return errorResponse(403, 'forbidden', 'this key may not read records');
  }
  return handleGetRecords(url, principal, deps);
}

/** 401 means "I don't know who you are"; 403 means "I know, and you may not do this". */
function unauthorized(): Response {
  return errorResponse(401, 'unauthorized', 'a valid Bearer key is required', {
    'www-authenticate': 'Bearer',
  });
}
