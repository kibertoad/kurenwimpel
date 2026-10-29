import type { OfrepRejection } from './options.js';

export function jsonResponse(status: number, body: unknown, headers: HeadersInit = {}): Response {
  const response = new Response(JSON.stringify(body), { status, headers });
  response.headers.set('content-type', 'application/json');
  return response;
}

export function emptyResponse(status: number, headers: HeadersInit = {}): Response {
  return new Response(null, { status, headers });
}

/** The spec's 500 body. Details stay generic so internals do not leak to callers. */
export function serverError(details: string): Response {
  return jsonResponse(500, { errorDetails: details });
}

export function rejectionResponse(rejection: OfrepRejection): Response {
  if (rejection.status !== 429 || rejection.retryAfter === undefined) {
    return emptyResponse(rejection.status);
  }

  const { retryAfter } = rejection;
  // An HTTP-date rather than ISO 8601: the OFREP JS client reads a leading
  // integer as seconds, so "2026-01-01T..." would mean 2026 seconds.
  const value =
    typeof retryAfter === 'number'
      ? String(Math.max(0, Math.ceil(retryAfter)))
      : retryAfter.toUTCString();
  return emptyResponse(429, { 'retry-after': value });
}
