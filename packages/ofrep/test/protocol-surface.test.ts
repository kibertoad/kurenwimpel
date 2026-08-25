/**
 * The declared surface of the protocol: the constants, the OpenAPI metadata,
 * and each schema's required core. This package *is* its declarations — a
 * contract whose summary vanished or whose request schema stopped requiring a
 * context still type-checks, and only the generated document would show it.
 */

import { describe, expect, it } from 'vitest';
import * as z from 'zod/mini';

import {
  bulkEvaluationFailureSchema,
  bulkEvaluationRequestHeadersSchema,
  bulkEvaluationRequestSchema,
  evaluateFlagContract,
  evaluateFlagsBulkContract,
  evaluationRequestSchema,
  generalErrorResponseSchema,
  ofrepAuthHeadersSchema,
  OFREP_EVALUATE_PATH,
  OFREP_PROTOCOL_VERSION,
  REFETCH_EVALUATION_EVENT_TYPE,
  SSE_EVENT_STREAM_TYPE,
} from '../src/index.js';

describe('protocol constants', () => {
  it('pins the wire literals to their specification values', () => {
    // These are matched byte-for-byte by servers and providers on the other
    // side of the wire; the expected values are the document's, not the code's.
    expect(OFREP_PROTOCOL_VERSION).toBe('0.3.0');
    expect(OFREP_EVALUATE_PATH).toBe('/ofrep/v1/evaluate/flags');
    expect(SSE_EVENT_STREAM_TYPE).toBe('sse');
    expect(REFETCH_EVALUATION_EVENT_TYPE).toBe('refetchEvaluation');
  });
});

describe('OpenAPI metadata', () => {
  const contracts = [evaluateFlagContract, evaluateFlagsBulkContract];

  it('documents both routes: method, tag, summary, description', () => {
    for (const contract of contracts) {
      expect(contract.method).toBe('post');
      expect(contract.tags).toEqual(['OFREP Core']);
      expect(contract.summary.length).toBeGreaterThan(0);
      expect(contract.description.length).toBeGreaterThan(0);
    }
  });

  it('documents every no-body response', () => {
    // A 401 rendered without a description is an empty row in the generated
    // document — the one place an implementer looks up what the status means.
    const noBody = [
      evaluateFlagContract.responsesByStatusCode[401],
      evaluateFlagContract.responsesByStatusCode[403],
      evaluateFlagContract.responsesByStatusCode[429],
      evaluateFlagsBulkContract.responsesByStatusCode[304],
      evaluateFlagsBulkContract.responsesByStatusCode[401],
      evaluateFlagsBulkContract.responsesByStatusCode[403],
      evaluateFlagsBulkContract.responsesByStatusCode[429],
    ] as { description?: string }[];

    for (const response of noBody) {
      expect(response.description?.length ?? 0).toBeGreaterThan(0);
    }
  });
});

describe('the required core of each schema', () => {
  it('requires a context on both evaluation requests', () => {
    expect(z.safeParse(evaluationRequestSchema, {}).success).toBe(false);
    expect(z.safeParse(bulkEvaluationRequestSchema, {}).success).toBe(false);

    const withContext = { context: { targetingKey: 'u1' } };
    expect(z.safeParse(evaluationRequestSchema, withContext).success).toBe(true);
    expect(z.safeParse(bulkEvaluationRequestSchema, withContext).success).toBe(true);
  });

  it('requires an errorCode on a bulk failure', () => {
    expect(z.safeParse(bulkEvaluationFailureSchema, {}).success).toBe(false);
    expect(z.safeParse(bulkEvaluationFailureSchema, { errorCode: 'GENERAL' }).success).toBe(true);
  });

  it('types the optional fields it declares, rather than passing them as unknowns', () => {
    // A looseObject carries unknown fields through, so dropping a declared
    // field would not reject anything — it would silently stop validating it.
    expect(z.safeParse(generalErrorResponseSchema, { errorDetails: 123 }).success).toBe(false);
    expect(z.safeParse(ofrepAuthHeadersSchema, { authorization: 123 }).success).toBe(false);
    expect(z.safeParse(bulkEvaluationRequestHeadersSchema, { 'if-none-match': 123 }).success).toBe(
      false,
    );
    expect(
      z.safeParse(bulkEvaluationRequestHeadersSchema, {
        authorization: 'Bearer t',
        'if-none-match': 'W/"rev-1"',
      }).success,
    ).toBe(true);
  });
});
