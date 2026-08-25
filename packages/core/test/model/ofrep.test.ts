/**
 * The core's side of the OFREP handshake: every evaluation reason and error
 * code must land on a defined wire value. This mapping is what a server
 * handler serves verbatim, so each case is pinned individually — a swapped or
 * dropped branch here silently relabels every response on the wire.
 */

import { describe, expect, it } from 'vitest';

import { toOfrepErrorCode, toOfrepReason } from '../../src/index.js';
import type { EvaluationErrorCode, EvaluationReason, OfrepErrorCode } from '../../src/index.js';

describe('toOfrepReason', () => {
  it('passes through the reasons OFREP spells identically', () => {
    expect(toOfrepReason('STATIC')).toBe('STATIC');
    expect(toOfrepReason('TARGETING_MATCH')).toBe('TARGETING_MATCH');
    expect(toOfrepReason('SPLIT')).toBe('SPLIT');
    expect(toOfrepReason('DISABLED')).toBe('DISABLED');
  });

  it('maps NOT_ALLOCATED to STATIC: the configured default was served', () => {
    expect(toOfrepReason('NOT_ALLOCATED')).toBe('STATIC');
  });

  it('maps PREREQUISITE_FAILED to DISABLED: a gate upstream closed the flag', () => {
    expect(toOfrepReason('PREREQUISITE_FAILED')).toBe('DISABLED');
  });

  it('refuses ERROR: a failed evaluation is an evaluationFailure, not a reason', () => {
    expect(toOfrepReason('ERROR')).toBeUndefined();
  });

  it('answers undefined for a reason it does not know rather than mislabelling it', () => {
    // A newer core handing a reason this mapping has no branch for must not
    // fall through to some arbitrary wire value.
    expect(toOfrepReason('FUTURE_REASON' as EvaluationReason)).toBeUndefined();
  });
});

describe('toOfrepErrorCode', () => {
  const expected: Record<EvaluationErrorCode, OfrepErrorCode> = {
    FLAG_NOT_FOUND: 'FLAG_NOT_FOUND',
    INVALID_DEFINITION: 'PARSE_ERROR',
    TARGETING_KEY_MISSING: 'TARGETING_KEY_MISSING',
    PROVIDER_NOT_READY: 'GENERAL',
    VARIANT_NOT_FOUND: 'GENERAL',
    TYPE_MISMATCH: 'GENERAL',
  };

  it.each(Object.entries(expected))('maps %s to %s', (code, wire) => {
    expect(toOfrepErrorCode(code as EvaluationErrorCode)).toBe(wire);
  });
});
