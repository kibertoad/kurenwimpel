import { describe, expect, it } from 'vitest';
import * as z from 'zod/mini';

import {
  booleanEvaluationSchema,
  codeDefaultEvaluationSchema,
  evaluationContextSchema,
  evaluationFailureSchema,
  evaluationRequestSchema,
  evaluationSuccessSchema,
  flagNotFoundSchema,
  generalErrorResponseSchema,
  integerEvaluationSchema,
  metadataSchema,
  objectEvaluationSchema,
} from '../src/index.js';
import {
  FLAG_NOT_FOUND,
  GENERAL_ERROR,
  SINGLE_EVALUATION_FAILURE,
  SINGLE_EVALUATION_REQUEST,
  SINGLE_EVALUATION_SUCCESS,
} from './fixtures.js';

describe('evaluation request', () => {
  it('accepts the specification example', () => {
    const result = z.safeParse(evaluationRequestSchema, SINGLE_EVALUATION_REQUEST);
    expect(result.success).toBe(true);
  });

  it('keeps unrecognised context attributes instead of stripping them', () => {
    const result = z.safeParse(evaluationContextSchema, {
      targetingKey: 'user-1',
      'custom-plan': 'premium',
      roles: ['admin'],
    });

    expect(result.data).toEqual({
      targetingKey: 'user-1',
      'custom-plan': 'premium',
      roles: ['admin'],
    });
  });

  it('requires a targeting key', () => {
    expect(z.safeParse(evaluationContextSchema, { email: 'a@example.com' }).success).toBe(false);
  });
});

describe('evaluation success', () => {
  it('accepts the specification example', () => {
    const result = z.safeParse(evaluationSuccessSchema, SINGLE_EVALUATION_SUCCESS);
    expect(result.success).toBe(true);
    expect(result.data).toEqual(SINGLE_EVALUATION_SUCCESS);
  });

  it.each([
    ['boolean', true],
    ['string', 'blue'],
    ['integer', 3],
    ['float', 1.5],
    ['object', { perMinute: 600 }],
  ])('accepts a %s value', (_name, value) => {
    const result = z.safeParse(evaluationSuccessSchema, { key: 'k', reason: 'STATIC', value });
    expect(result.success).toBe(true);
  });

  it('accepts a code default, which carries no value at all', () => {
    const result = z.safeParse(evaluationSuccessSchema, { key: 'k', reason: 'STATIC' });
    expect(result.success).toBe(true);
  });

  it('does not read an unrepresentable value as a code default', () => {
    // Without the `optional(never())` guard on the code-default branch this would
    // match it, and a null would be reported as "use your hard-coded default".
    expect(
      z.safeParse(codeDefaultEvaluationSchema, { key: 'k', reason: 'STATIC', value: null }).success,
    ).toBe(false);
    expect(
      z.safeParse(evaluationSuccessSchema, { key: 'k', reason: 'STATIC', value: null }).success,
    ).toBe(false);
  });

  it('rejects a fractional integer flag', () => {
    expect(
      z.safeParse(integerEvaluationSchema, { key: 'k', reason: 'STATIC', value: 1.5 }).success,
    ).toBe(false);
  });

  it('rejects an array as an object flag value', () => {
    // JSON Schema's `type: object` excludes arrays and null. Pinned because
    // the obvious loosening — `z.unknown()`, to mean "any JSON" — would let
    // both through and quietly widen what the protocol says a flag can hold.
    expect(
      z.safeParse(objectEvaluationSchema, { key: 'k', reason: 'STATIC', value: [1] }).success,
    ).toBe(false);
  });

  it('rejects a reason outside the protocol enum', () => {
    expect(
      z.safeParse(booleanEvaluationSchema, { key: 'k', reason: 'CACHED', value: true }).success,
    ).toBe(false);
  });

  it('requires a reason, which is what tells a bulk entry apart from a failure', () => {
    expect(z.safeParse(evaluationSuccessSchema, { key: 'k', value: true }).success).toBe(false);
  });
});

describe('metadata', () => {
  it('is flat: JSON primitives only, and never an array', () => {
    // Metadata is one level deep by definition: a nested object or an array
    // is not a JSON primitive, and neither is a legal value.
    expect(z.safeParse(metadataSchema, { team: 'ecommerce', tier: 2, beta: true }).success).toBe(
      true,
    );
    expect(z.safeParse(metadataSchema, { owner: { team: 'x' } }).success).toBe(false);
    expect(z.safeParse(metadataSchema, ['ecommerce']).success).toBe(false);
  });
});

describe('failure bodies', () => {
  it('accepts the evaluation failure example', () => {
    expect(z.safeParse(evaluationFailureSchema, SINGLE_EVALUATION_FAILURE).success).toBe(true);
  });

  it('accepts the flag-not-found example', () => {
    expect(z.safeParse(flagNotFoundSchema, FLAG_NOT_FOUND).success).toBe(true);
  });

  it('accepts the general error example', () => {
    expect(z.safeParse(generalErrorResponseSchema, GENERAL_ERROR).success).toBe(true);
  });

  it('keeps FLAG_NOT_FOUND out of the evaluation failure codes', () => {
    // The protocol models an unknown key as its own 404 body, not as a failed
    // evaluation, so the two error-code sets stay disjoint.
    expect(z.safeParse(evaluationFailureSchema, FLAG_NOT_FOUND).success).toBe(false);
    expect(z.safeParse(flagNotFoundSchema, SINGLE_EVALUATION_FAILURE).success).toBe(false);
  });

  it('requires an error code, the other half of bulk entry discrimination', () => {
    expect(z.safeParse(evaluationFailureSchema, { key: 'k' }).success).toBe(false);
  });
});
