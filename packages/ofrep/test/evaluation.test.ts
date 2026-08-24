import { safeParse } from 'valibot';
import { describe, expect, it } from 'vitest';

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
    const result = safeParse(evaluationRequestSchema, SINGLE_EVALUATION_REQUEST);
    expect(result.success).toBe(true);
  });

  it('keeps unrecognised context attributes instead of stripping them', () => {
    const result = safeParse(evaluationContextSchema, {
      targetingKey: 'user-1',
      'custom-plan': 'premium',
      roles: ['admin'],
    });

    expect(result.output).toEqual({
      targetingKey: 'user-1',
      'custom-plan': 'premium',
      roles: ['admin'],
    });
  });

  it('requires a targeting key', () => {
    expect(safeParse(evaluationContextSchema, { email: 'a@example.com' }).success).toBe(false);
  });
});

describe('evaluation success', () => {
  it('accepts the specification example', () => {
    const result = safeParse(evaluationSuccessSchema, SINGLE_EVALUATION_SUCCESS);
    expect(result.success).toBe(true);
    expect(result.output).toEqual(SINGLE_EVALUATION_SUCCESS);
  });

  it.each([
    ['boolean', true],
    ['string', 'blue'],
    ['integer', 3],
    ['float', 1.5],
    ['object', { perMinute: 600 }],
  ])('accepts a %s value', (_name, value) => {
    const result = safeParse(evaluationSuccessSchema, { key: 'k', reason: 'STATIC', value });
    expect(result.success).toBe(true);
  });

  it('accepts a code default, which carries no value at all', () => {
    const result = safeParse(evaluationSuccessSchema, { key: 'k', reason: 'STATIC' });
    expect(result.success).toBe(true);
  });

  it('does not read an unrepresentable value as a code default', () => {
    // Without the `optional(never())` guard on the code-default branch this would
    // match it, and a null would be reported as "use your hard-coded default".
    expect(
      safeParse(codeDefaultEvaluationSchema, { key: 'k', reason: 'STATIC', value: null }).success,
    ).toBe(false);
    expect(
      safeParse(evaluationSuccessSchema, { key: 'k', reason: 'STATIC', value: null }).success,
    ).toBe(false);
  });

  it('rejects a fractional integer flag', () => {
    expect(
      safeParse(integerEvaluationSchema, { key: 'k', reason: 'STATIC', value: 1.5 }).success,
    ).toBe(false);
  });

  it('rejects an array as an object flag value', () => {
    // `record` would otherwise coerce it into `{ "0": 1 }` and report success.
    expect(
      safeParse(objectEvaluationSchema, { key: 'k', reason: 'STATIC', value: [1] }).success,
    ).toBe(false);
  });

  it('rejects a reason outside the protocol enum', () => {
    expect(
      safeParse(booleanEvaluationSchema, { key: 'k', reason: 'CACHED', value: true }).success,
    ).toBe(false);
  });

  it('requires a reason', () => {
    expect(safeParse(evaluationSuccessSchema, { key: 'k', value: true }).success).toBe(false);
  });
});

describe('metadata', () => {
  it('accepts JSON primitives', () => {
    const result = safeParse(metadataSchema, { team: 'ecommerce', tier: 2, beta: true });
    expect(result.success).toBe(true);
  });

  it('rejects nested objects and arrays', () => {
    expect(safeParse(metadataSchema, { owner: { team: 'x' } }).success).toBe(false);
    expect(safeParse(metadataSchema, ['ecommerce']).success).toBe(false);
  });
});

describe('failure bodies', () => {
  it('accepts the evaluation failure example', () => {
    expect(safeParse(evaluationFailureSchema, SINGLE_EVALUATION_FAILURE).success).toBe(true);
  });

  it('accepts the flag-not-found example', () => {
    expect(safeParse(flagNotFoundSchema, FLAG_NOT_FOUND).success).toBe(true);
  });

  it('accepts the general error example', () => {
    expect(safeParse(generalErrorResponseSchema, GENERAL_ERROR).success).toBe(true);
  });

  it('keeps FLAG_NOT_FOUND out of the evaluation failure codes', () => {
    // The protocol models an unknown key as its own 404 body, not as a failed
    // evaluation, so the two error-code sets stay disjoint.
    expect(safeParse(evaluationFailureSchema, FLAG_NOT_FOUND).success).toBe(false);
    expect(safeParse(flagNotFoundSchema, SINGLE_EVALUATION_FAILURE).success).toBe(false);
  });

  it('rejects a failure without an error code', () => {
    expect(safeParse(evaluationFailureSchema, { key: 'k' }).success).toBe(false);
  });
});
