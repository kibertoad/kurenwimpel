import { EvaluationErrorCode, EvaluationReason } from '@kurenwimpel/core';
import { ErrorCode, StandardResolutionReasons } from '@openfeature/server-sdk';
import { describe, expect, it } from 'vitest';

import { toEngineContext, toOpenFeatureErrorCode, toOpenFeatureReason } from '../src/index.js';

describe('toOpenFeatureReason', () => {
  it.each([
    [EvaluationReason.Static, StandardResolutionReasons.STATIC],
    [EvaluationReason.NotAllocated, StandardResolutionReasons.STATIC],
    [EvaluationReason.TargetingMatch, StandardResolutionReasons.TARGETING_MATCH],
    [EvaluationReason.Split, StandardResolutionReasons.SPLIT],
    [EvaluationReason.Disabled, StandardResolutionReasons.DISABLED],
    [EvaluationReason.PrerequisiteFailed, StandardResolutionReasons.DISABLED],
    [EvaluationReason.Error, StandardResolutionReasons.ERROR],
  ])('maps %s to %s', (reason, expected) => {
    expect(toOpenFeatureReason(reason)).toBe(expected);
  });

  it('covers every evaluation reason', () => {
    for (const reason of Object.values(EvaluationReason)) {
      expect(Object.values(StandardResolutionReasons)).toContain(toOpenFeatureReason(reason));
    }
  });
});

describe('toOpenFeatureErrorCode', () => {
  it.each([
    [EvaluationErrorCode.FlagNotFound, ErrorCode.FLAG_NOT_FOUND],
    [EvaluationErrorCode.ProviderNotReady, ErrorCode.PROVIDER_NOT_READY],
    [EvaluationErrorCode.TargetingKeyMissing, ErrorCode.TARGETING_KEY_MISSING],
    [EvaluationErrorCode.VariantNotFound, ErrorCode.GENERAL],
    [EvaluationErrorCode.TypeMismatch, ErrorCode.TYPE_MISMATCH],
    [EvaluationErrorCode.InvalidDefinition, ErrorCode.PARSE_ERROR],
  ])('maps %s to %s', (code, expected) => {
    expect(toOpenFeatureErrorCode(code)).toBe(expected);
  });

  it('covers every evaluation error code', () => {
    for (const code of Object.values(EvaluationErrorCode)) {
      expect(Object.values(ErrorCode)).toContain(toOpenFeatureErrorCode(code));
    }
  });
});

describe('toEngineContext', () => {
  it('converts a top-level Date to epoch millis', () => {
    expect(toEngineContext({ signedUpAt: new Date(1_700_000_000_000) })).toEqual({
      signedUpAt: 1_700_000_000_000,
    });
  });

  it('passes nested values and the targeting key through unchanged', () => {
    const nested = { plan: { tier: 'pro', since: new Date(0) }, roles: ['admin'] };

    const mapped = toEngineContext({ targetingKey: 'user-1', ...nested });

    expect(mapped).toEqual({ targetingKey: 'user-1', ...nested });
    expect(mapped['plan']).toBe(nested.plan);
  });

  it('leaves a missing targeting key missing', () => {
    expect(toEngineContext({ country: 'LT' })).not.toHaveProperty('targetingKey');
  });
});
