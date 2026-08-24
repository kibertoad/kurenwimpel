import { describeApiContract, isNoBodyResponse, resolveStatusEntry } from '@toad-contracts/core';
import { safeParse } from 'valibot';
import { describe, expect, it } from 'vitest';

import {
  bulkEvaluationQuerySchema,
  evaluateFlagContract,
  evaluateFlagPathParamsSchema,
  evaluateFlagsBulkContract,
  ofrepAuthHeadersSchema,
  ofrepResponseHeadersSchema,
} from '../src/index.js';
import {
  BULK_EVALUATION_SUCCESS,
  FLAG_NOT_FOUND,
  SINGLE_EVALUATION_REQUEST,
  SINGLE_EVALUATION_SUCCESS,
} from './fixtures.js';

const singleFlagResponses = evaluateFlagContract.responsesByStatusCode;
const bulkResponses = evaluateFlagsBulkContract.responsesByStatusCode;

/**
 * Path mapping is the one thing in this package that computes rather than
 * declares: `withObjectKeys` hands the parameter name to `mapApiContractToPath`,
 * which rebuilds the route from it. Expected values below are the literal paths
 * from the OpenAPI document, never rebuilt from the constants the source used —
 * an assertion derived from the code it is checking proves nothing.
 */
describe('route paths', () => {
  it('maps the single-flag route to its specification path', () => {
    expect(describeApiContract(evaluateFlagContract)).toBe('POST /ofrep/v1/evaluate/flags/:key');
  });

  it('maps the bulk route to its specification path', () => {
    expect(describeApiContract(evaluateFlagsBulkContract)).toBe('POST /ofrep/v1/evaluate/flags');
  });

  it('interpolates a key without escaping it', () => {
    // Escaping here would corrupt the `:key` placeholder that path mapping
    // depends on, so a key containing a slash reaches the URL as a slash and
    // encoding is the caller's job. Asserted so the trade-off is not silently
    // reversed by someone reaching for encodeURIComponent.
    expect(evaluateFlagContract.pathResolver({ key: 'discount-banner' })).toBe(
      '/ofrep/v1/evaluate/flags/discount-banner',
    );
    expect(evaluateFlagContract.pathResolver({ key: 'a/b' })).toBe('/ofrep/v1/evaluate/flags/a/b');
  });

  it('rejects an empty key, which would address the bulk route instead', () => {
    expect(safeParse(evaluateFlagPathParamsSchema, { key: '' }).success).toBe(false);
    expect(safeParse(evaluateFlagPathParamsSchema, { key: 'k' }).success).toBe(true);
  });
});

describe('status codes', () => {
  it.each([
    ['single-flag', singleFlagResponses, [200, 400, 401, 403, 404, 429, 500]],
    ['bulk', bulkResponses, [200, 304, 400, 401, 403, 429, 500]],
  ])('the %s route answers every status the document defines', (_name, responses, expected) => {
    // Transcribed from the document's `responses` maps, independently of the
    // source. Order is not part of the claim.
    const declared = Object.keys(responses)
      .map(Number)
      .toSorted((a, b) => a - b);
    expect(declared).toEqual(expected);
  });

  it('resolves no status the document does not define', () => {
    // The contract declares no `'4xx'` or `'default'` wildcard, so an
    // undocumented status surfaces as unhandled instead of being quietly parsed
    // as some other status's body. A 404 is documented on one route only.
    expect(resolveStatusEntry(singleFlagResponses, 418)).toBeUndefined();
    expect(resolveStatusEntry(singleFlagResponses, 404)).toBeDefined();
    expect(resolveStatusEntry(bulkResponses, 404)).toBeUndefined();
  });

  it.each([
    ['single-flag', singleFlagResponses, [401, 403, 429]],
    ['bulk', bulkResponses, [304, 401, 403, 429]],
  ])('the %s route sends no body where the document defines none', (_name, responses, codes) => {
    for (const code of codes) {
      expect(isNoBodyResponse(responses[code as keyof typeof responses])).toBe(true);
    }
  });
});

/**
 * Each status gets its own schema so that a client which skipped the status
 * check cannot parse its way to a wrong answer. That only holds if the bodies
 * are mutually exclusive, which is a property of the schemas rather than of the
 * contract's shape — and the one thing about the wiring worth asserting.
 */
describe('response bodies are not interchangeable', () => {
  it('will not read a not-found body as a successful evaluation', () => {
    expect(safeParse(singleFlagResponses[200], FLAG_NOT_FOUND).success).toBe(false);
  });

  it('will not read a successful evaluation as a not-found body', () => {
    expect(safeParse(singleFlagResponses[404], SINGLE_EVALUATION_SUCCESS).success).toBe(false);
  });

  it('will not read a single-flag body as a bulk one', () => {
    expect(safeParse(bulkResponses[200], SINGLE_EVALUATION_SUCCESS).success).toBe(false);
  });

  it('will not read a bulk body as a single-flag one', () => {
    expect(safeParse(singleFlagResponses[200], BULK_EVALUATION_SUCCESS).success).toBe(false);
  });

  it('accepts each route its own body, so the exclusions above are not vacuous', () => {
    expect(safeParse(singleFlagResponses[200], SINGLE_EVALUATION_SUCCESS).success).toBe(true);
    expect(safeParse(singleFlagResponses[404], FLAG_NOT_FOUND).success).toBe(true);
    expect(safeParse(bulkResponses[200], BULK_EVALUATION_SUCCESS).success).toBe(true);
    expect(
      safeParse(evaluateFlagContract.requestBodySchema, SINGLE_EVALUATION_REQUEST).success,
    ).toBe(true);
  });
});

describe('headers and query parameters', () => {
  it('keeps headers it does not declare, so a proxy header is not a failure', () => {
    const result = safeParse(ofrepAuthHeadersSchema, {
      authorization: 'Bearer t',
      'x-request-id': 'r1',
    });

    expect(result.output).toEqual({ authorization: 'Bearer t', 'x-request-id': 'r1' });
  });

  it('types retry-after as a string, because HTTP never sends it as a number', () => {
    expect(safeParse(ofrepResponseHeadersSchema, { 'retry-after': '120' }).success).toBe(true);
    expect(safeParse(ofrepResponseHeadersSchema, { 'retry-after': 120 }).success).toBe(false);
  });

  it('rejects a query timestamp in the form a query string would actually carry it', () => {
    // The document types `flagConfigLastModified` as a number or an ISO 8601
    // string, and the contract follows it — but a query string carries neither,
    // so a server reading `"1771622898"` has to coerce before validating. This
    // is the footgun, pinned so it stays documented rather than discovered.
    expect(
      safeParse(bulkEvaluationQuerySchema, { flagConfigLastModified: 1_771_622_898 }).success,
    ).toBe(true);
    expect(
      safeParse(bulkEvaluationQuerySchema, { flagConfigLastModified: '1771622898' }).success,
    ).toBe(false);
  });
});
