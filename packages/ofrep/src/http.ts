/**
 * The parts of the contract that live outside the body: headers and query
 * parameters.
 *
 * Header schemas are keyed lowercase, matching `Headers` normalisation on both
 * `fetch` and Node's HTTP server, and every entry is optional. OFREP declares
 * its two authentication schemes as alternatives that a flag management system
 * *may* support, and the conditional-request headers are opt-in, so nothing here
 * can be demanded of an arbitrary implementation.
 */

import * as z from 'zod/mini';

import { flagConfigLastModifiedSchema } from './event-stream.js';

/**
 * The two authentication schemes from `components/securitySchemes`, as request
 * headers: `Authorization: Bearer <token>` and `X-API-Key: <key>`.
 */
export const ofrepAuthHeadersSchema = z.looseObject({
  authorization: z.optional(z.string()),
  'x-api-key': z.optional(z.string()),
});

export type OfrepAuthHeaders = z.infer<typeof ofrepAuthHeadersSchema>;

/** Auth plus the `If-None-Match` conditional the bulk route answers with a 304. */
export const bulkEvaluationRequestHeadersSchema = z.looseObject({
  authorization: z.optional(z.string()),
  'x-api-key': z.optional(z.string()),
  'if-none-match': z.optional(z.string()),
});

export type OfrepBulkRequestHeaders = z.infer<typeof bulkEvaluationRequestHeadersSchema>;

/**
 * `flagConfigEtag` and `flagConfigLastModified` — cache-validation metadata
 * echoed back from a `refetchEvaluation` event. Both belong on the query string
 * rather than in `If-None-Match` / `If-Modified-Since`, and both should only be
 * sent when the request was actually triggered by such an event.
 *
 * `flagConfigLastModified` is typed as the spec declares it, as a number or an
 * ISO 8601 string. A query string carries neither: a server reads `"1771622898"`
 * and has to coerce before validating.
 */
export const bulkEvaluationQuerySchema = z.looseObject({
  flagConfigEtag: z.optional(z.string()),
  flagConfigLastModified: z.optional(flagConfigLastModifiedSchema),
});

export type OfrepBulkQuery = z.infer<typeof bulkEvaluationQuerySchema>;

/**
 * Response headers either route may set.
 *
 * A contract carries one response-header schema for all of its status codes, but
 * these are per-status in the spec — `etag` on a bulk 200, `retry-after` on a
 * 429 — so both are optional and a consumer checks the status before reading one.
 *
 * `retry-after` is a string because HTTP says so: it is either a delay in seconds
 * or an HTTP-date, never a JSON number.
 */
export const ofrepResponseHeadersSchema = z.looseObject({
  etag: z.optional(z.string()),
  'retry-after': z.optional(z.string()),
});

export type OfrepResponseHeaders = z.infer<typeof ofrepResponseHeadersSchema>;
