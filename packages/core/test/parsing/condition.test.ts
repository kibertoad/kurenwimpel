/**
 * `parseCondition` on its own: the operator-by-operator value contracts.
 * Rule-level behaviour — what a dropped rule costs a flag or a segment — lives
 * in `flag.test.ts` and `segment.test.ts`; this is the layer below, where each
 * operator either gets the one value shape it can evaluate or throws.
 */

import { describe, expect, it } from 'vitest';

import { FlagParseError, parseCondition } from '../../src/index.js';

const parse = (raw: unknown): unknown => parseCondition(raw, 'flag f: rule r');

describe('parseCondition', () => {
  it('rejects a condition that is not an object', () => {
    expect(() => parse(null)).toThrow(FlagParseError);
    expect(() => parse('exists')).toThrow(/non-object condition/u);
  });

  it('parses the presence operators without a value', () => {
    expect(parse({ attribute: 'beta', operator: 'exists' })).toEqual({
      attribute: 'beta',
      operator: 'exists',
    });
    expect(parse({ attribute: 'beta', operator: 'notExists' })).toEqual({
      attribute: 'beta',
      operator: 'notExists',
    });
  });

  it('accepts every scalar type for the equality pair, booleans included', () => {
    expect(parse({ attribute: 'beta', operator: 'eq', value: true })).toEqual({
      attribute: 'beta',
      operator: 'eq',
      value: true,
    });
    expect(parse({ attribute: 'plan', operator: 'neq', value: 'free' })).toMatchObject({
      value: 'free',
    });
    expect(() => parse({ attribute: 'plan', operator: 'eq', value: ['free'] })).toThrow(
      /needs a string, number, or boolean/u,
    );
    expect(() => parse({ attribute: 'plan', operator: 'eq', value: null })).toThrow(FlagParseError);
  });

  it('requires finite numbers inside a set operator list', () => {
    // A NaN entry equals nothing, itself included: `in` could never match it
    // and `notIn` would carry a member it can never exclude.
    expect(() => parse({ attribute: 'seats', operator: 'in', value: [1, Number.NaN] })).toThrow(
      /strings or finite numbers/u,
    );
    expect(() =>
      parse({ attribute: 'seats', operator: 'notIn', value: [Number.POSITIVE_INFINITY] }),
    ).toThrow(FlagParseError);
    expect(parse({ attribute: 'seats', operator: 'in', value: [1, 'two'] })).toMatchObject({
      value: [1, 'two'],
    });
  });

  it('copies a set operator list instead of aliasing the payload', () => {
    const value = ['pro'];
    const parsed = parse({ attribute: 'plan', operator: 'in', value }) as { value: string[] };

    value.push('free');
    expect(parsed.value).toEqual(['pro']);
  });

  it('requires a finite number for the comparison operators', () => {
    expect(() => parse({ attribute: 'seats', operator: 'gt', value: '10' })).toThrow(
      /finite number value/u,
    );
    expect(() => parse({ attribute: 'seats', operator: 'lte', value: Number.NaN })).toThrow(
      FlagParseError,
    );
    expect(parse({ attribute: 'seats', operator: 'gte', value: 10 })).toMatchObject({
      value: 10,
    });
  });

  it('requires a parseable version for the semver operators', () => {
    expect(() =>
      parse({ attribute: 'appVersion', operator: 'semverGte', value: 'not-a-version' }),
    ).toThrow(/semantic version string/u);
    expect(() => parse({ attribute: 'appVersion', operator: 'semverLt', value: 3 })).toThrow(
      FlagParseError,
    );
    expect(parse({ attribute: 'appVersion', operator: 'semverEq', value: 'v2.1' })).toMatchObject({
      value: 'v2.1',
    });
  });

  it('requires a non-empty segment list on the segment operators', () => {
    expect(() => parse({ operator: 'inSegment', segments: [] })).toThrow(
      /at least one segment key/u,
    );
    expect(() => parse({ operator: 'notInSegment', segments: 'beta' })).toThrow(
      /array of strings/u,
    );
    expect(parse({ operator: 'notInSegment', segments: ['beta'] })).toEqual({
      operator: 'notInSegment',
      segments: ['beta'],
    });
  });
});
