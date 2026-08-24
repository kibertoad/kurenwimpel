import {
  describeApiContract,
  isNoBodyResponse,
  mapApiContractToPath,
  resolveStatusEntry,
} from '@toad-contracts/core';
import { safeParse } from 'valibot';
import { describe, expect, it } from 'vitest';

import {
  bulkEvaluationQuerySchema,
  bulkEvaluationRequestHeadersSchema,
  evaluateFlagContract,
  evaluateFlagPathParamsSchema,
  evaluateFlagsBulkContract,
  OFREP_CONTRACTS,
  OFREP_EVALUATE_PATH,
  ofrepAuthHeadersSchema,
  ofrepResponseHeadersSchema,
} from '../src/index.js';
import {
  BULK_EVALUATION_SUCCESS,
  FLAG_NOT_FOUND,
  SINGLE_EVALUATION_REQUEST,
  SINGLE_EVALUATION_SUCCESS,
} from './fixtures.js';

describe('routes', () => {
  it('exposes exactly the two core routes', () => {
    expect(Object.keys(OFREP_CONTRACTS)).toEqual(['evaluateFlag', 'evaluateFlagsBulk']);
  });

  it('maps the single-flag route to its specification path', () => {
    expect(describeApiContract(evaluateFlagContract)).toBe('POST /ofrep/v1/evaluate/flags/:key');
  });

  it('maps the bulk route to its specification path', () => {
    expect(describeApiContract(evaluateFlagsBulkContract)).toBe('POST /ofrep/v1/evaluate/flags');
  });

  it('resolves a concrete path from a flag key', () => {
    expect(evaluateFlagContract.pathResolver({ key: 'discount-banner' })).toBe(
      `${OFREP_EVALUATE_PATH}/discount-banner`,
    );
  });

  it('distinguishes the two routes only by the path parameter', () => {
    // Both are POSTs to the same prefix, so a server has to route on the
    // presence of a key. An empty one would collapse them together.
    expect(mapApiContractToPath(evaluateFlagsBulkContract)).toBe(
      mapApiContractToPath(evaluateFlagContract).replace('/:key', ''),
    );
    expect(safeParse(evaluateFlagPathParamsSchema, { key: '' }).success).toBe(false);
  });
});

describe('single-flag contract', () => {
  const { responsesByStatusCode } = evaluateFlagContract;

  it('covers every status code the specification documents', () => {
    expect(Object.keys(responsesByStatusCode)).toEqual([
      '200',
      '400',
      '401',
      '403',
      '404',
      '429',
      '500',
    ]);
  });

  it('validates the request body against the contract', () => {
    expect(
      safeParse(evaluateFlagContract.requestBodySchema, SINGLE_EVALUATION_REQUEST).success,
    ).toBe(true);
    expect(safeParse(evaluateFlagContract.requestBodySchema, { context: {} }).success).toBe(false);
  });

  it('validates a 200 against the contract', () => {
    expect(safeParse(responsesByStatusCode[200], SINGLE_EVALUATION_SUCCESS).success).toBe(true);
  });

  it('validates a 404 against the contract', () => {
    expect(safeParse(responsesByStatusCode[404], FLAG_NOT_FOUND).success).toBe(true);
  });

  it('declares the auth-only status codes as bodyless', () => {
    expect(isNoBodyResponse(responsesByStatusCode[401])).toBe(true);
    expect(isNoBodyResponse(responsesByStatusCode[403])).toBe(true);
    expect(isNoBodyResponse(responsesByStatusCode[429])).toBe(true);
  });

  it('declares both optional authentication schemes and neither as required', () => {
    expect(evaluateFlagContract.requestHeaderSchema).toBe(ofrepAuthHeadersSchema);
    expect(safeParse(ofrepAuthHeadersSchema, {}).success).toBe(true);
    expect(safeParse(ofrepAuthHeadersSchema, { authorization: 'Bearer t' }).success).toBe(true);
    expect(safeParse(ofrepAuthHeadersSchema, { 'x-api-key': 'k' }).success).toBe(true);
  });

  it('takes no query parameters', () => {
    expect(Object.hasOwn(evaluateFlagContract, 'requestQuerySchema')).toBe(false);
  });
});

describe('bulk contract', () => {
  const { responsesByStatusCode } = evaluateFlagsBulkContract;

  it('covers every status code the specification documents', () => {
    expect(Object.keys(responsesByStatusCode)).toEqual([
      '200',
      '304',
      '400',
      '401',
      '403',
      '429',
      '500',
    ]);
  });

  it('validates a 200 against the contract', () => {
    expect(safeParse(responsesByStatusCode[200], BULK_EVALUATION_SUCCESS).success).toBe(true);
  });

  it('declares the 304 as bodyless, since a cache hit sends nothing', () => {
    expect(isNoBodyResponse(responsesByStatusCode[304])).toBe(true);
  });

  it('accepts the conditional request header the 304 answers', () => {
    const result = safeParse(bulkEvaluationRequestHeadersSchema, { 'if-none-match': 'abc123xyz' });
    expect(result.success).toBe(true);
    expect(evaluateFlagsBulkContract.requestHeaderSchema).toBe(bulkEvaluationRequestHeadersSchema);
  });

  it('accepts the change-notification query parameters', () => {
    const result = safeParse(bulkEvaluationQuerySchema, {
      flagConfigEtag: '550e8400-e29b-41d4-a716-446655440000',
      flagConfigLastModified: 1_771_622_898,
    });
    expect(result.success).toBe(true);
    expect(evaluateFlagsBulkContract.requestQuerySchema).toBe(bulkEvaluationQuerySchema);
  });

  it('takes no path parameters', () => {
    expect(Object.hasOwn(evaluateFlagsBulkContract, 'requestPathParamsSchema')).toBe(false);
  });
});

describe('response headers', () => {
  it('are shared by both routes', () => {
    expect(evaluateFlagContract.responseHeaderSchema).toBe(ofrepResponseHeadersSchema);
    expect(evaluateFlagsBulkContract.responseHeaderSchema).toBe(ofrepResponseHeadersSchema);
  });

  it('are optional, because each belongs to one status code only', () => {
    // `etag` comes back on a bulk 200 and `retry-after` on a 429, but a contract
    // carries one response-header schema across all of its statuses.
    expect(safeParse(ofrepResponseHeadersSchema, {}).success).toBe(true);
    expect(safeParse(ofrepResponseHeadersSchema, { etag: 'abc123xyz' }).success).toBe(true);
    expect(safeParse(ofrepResponseHeadersSchema, { 'retry-after': '120' }).success).toBe(true);
  });
});

describe('status resolution', () => {
  it('has no wildcard entries, so every status resolves exactly or not at all', () => {
    expect(resolveStatusEntry(evaluateFlagContract.responsesByStatusCode, 404)).toBeDefined();
    expect(resolveStatusEntry(evaluateFlagContract.responsesByStatusCode, 418)).toBeUndefined();
    expect(
      resolveStatusEntry(evaluateFlagsBulkContract.responsesByStatusCode, 404),
    ).toBeUndefined();
  });
});
