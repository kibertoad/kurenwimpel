/**
 * The two routes a flag management system must serve to be OFREP compatible.
 *
 * These are the single source of truth for the protocol in this repository: a
 * server implements them, a client calls them, and both read the same schemas.
 */

import { defineApiContract, noBodyResponse } from '@toad-contracts/core';
import { withObjectKeys } from '@toad-contracts/zod';
import * as z from 'zod/mini';

import {
  bulkEvaluationFailureSchema,
  bulkEvaluationRequestSchema,
  bulkEvaluationSuccessSchema,
} from './bulk.js';
import { OFREP_EVALUATE_PATH } from './common.js';
import {
  evaluationFailureSchema,
  evaluationRequestSchema,
  flagNotFoundSchema,
  generalErrorResponseSchema,
  serverEvaluationSuccessSchema,
} from './evaluation.js';
import {
  bulkEvaluationQuerySchema,
  bulkEvaluationRequestHeadersSchema,
  ofrepAuthHeadersSchema,
  ofrepResponseHeadersSchema,
} from './http.js';

const UNAUTHORIZED = noBodyResponse({
  description: 'Authentication credentials are missing, invalid, or expired.',
});

const FORBIDDEN = noBodyResponse({
  description: 'The client does not have permission to access the requested resource.',
});

const RATE_LIMITED = noBodyResponse({
  description: 'Rate limit exceeded. `retry-after` carries a delay in seconds or an HTTP-date.',
});

/**
 * Path params of the single-flag route.
 *
 * `withObjectKeys` is what lets `mapApiContractToPath` learn the field name and
 * emit `/ofrep/v1/evaluate/flags/:key`; Standard Schema alone exposes no way to
 * list an object schema's keys.
 *
 * The one place this contract is stricter than the specification, which types
 * `key` as a bare string: an empty key does not address this route, it addresses
 * the bulk one.
 */
export const evaluateFlagPathParamsSchema = withObjectKeys(
  z.object({ key: z.string().check(z.minLength(1)) }),
);

/**
 * `POST /ofrep/v1/evaluate/flags/{key}` — evaluate one flag against a context
 * supplied per request. The server-side shape: targeting decisions are made on
 * data that changes between requests, so nothing is cached.
 *
 * The 404 is not an error path. Some flag management systems return it for a key
 * they have never heard of, and a provider is expected to fall back to the
 * caller's default rather than treat the response as a failure.
 *
 * `key` is interpolated raw so that the placeholder survives path mapping;
 * callers percent-encode keys that are not URL-safe.
 */
export const evaluateFlagContract = defineApiContract({
  method: 'post',
  summary: 'Evaluate a single feature flag',
  description:
    'Evaluates one flag by key against the supplied evaluation context. Used by server-side providers, where the context varies per request.',
  tags: ['OFREP Core'],
  requestPathParamsSchema: evaluateFlagPathParamsSchema,
  pathResolver: ({ key }) => `${OFREP_EVALUATE_PATH}/${key}`,
  requestHeaderSchema: ofrepAuthHeadersSchema,
  responseHeaderSchema: ofrepResponseHeadersSchema,
  requestBodySchema: evaluationRequestSchema,
  responsesByStatusCode: {
    200: serverEvaluationSuccessSchema,
    400: evaluationFailureSchema,
    401: UNAUTHORIZED,
    403: FORBIDDEN,
    404: flagNotFoundSchema,
    429: RATE_LIMITED,
    500: generalErrorResponseSchema,
  },
});

/**
 * `POST /ofrep/v1/evaluate/flags` — evaluate every flag at once against a static
 * context. The client-side shape: evaluate once, cache the result, re-evaluate
 * when the server says something changed.
 *
 * Change detection has two channels. `If-None-Match` against the `etag` of a
 * previous response gets a 304 and no body. If the previous response advertised
 * `eventStreams`, the provider connects to one and re-fetches on
 * `refetchEvaluation`, passing whatever cache metadata the event carried through
 * {@link bulkEvaluationQuerySchema}.
 */
export const evaluateFlagsBulkContract = defineApiContract({
  method: 'post',
  summary: 'Bulk evaluate all feature flags',
  description:
    'Evaluates every flag in one request against a static context, returning an ETag for cache validation. Used by client-side providers.',
  tags: ['OFREP Core'],
  pathResolver: () => OFREP_EVALUATE_PATH,
  requestHeaderSchema: bulkEvaluationRequestHeadersSchema,
  requestQuerySchema: bulkEvaluationQuerySchema,
  responseHeaderSchema: ofrepResponseHeadersSchema,
  requestBodySchema: bulkEvaluationRequestSchema,
  responsesByStatusCode: {
    200: bulkEvaluationSuccessSchema,
    304: noBodyResponse({ description: 'Flags are unchanged since the supplied ETag.' }),
    400: bulkEvaluationFailureSchema,
    401: UNAUTHORIZED,
    403: FORBIDDEN,
    429: RATE_LIMITED,
    500: generalErrorResponseSchema,
  },
});

/** Every route of the protocol, for consumers that mount or exercise them as a set. */
export const OFREP_CONTRACTS = {
  evaluateFlag: evaluateFlagContract,
  evaluateFlagsBulk: evaluateFlagsBulkContract,
} as const;
