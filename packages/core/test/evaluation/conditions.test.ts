import { describe, expect, it } from 'vitest';

import { compileSegment, isInSegment, matchesCondition } from '../../src/index.js';
import type { AttributeValue, Condition, SegmentMap } from '../../src/index.js';

const check = (condition: Condition, context: Record<string, AttributeValue>): boolean =>
  matchesCondition(condition, context);

describe('matchesCondition', () => {
  it('compares numbers without coercion', () => {
    expect(check({ attribute: 'seats', operator: 'gt', value: 10 }, { seats: 11 })).toBe(true);
    expect(check({ attribute: 'seats', operator: 'gt', value: 10 }, { seats: 10 })).toBe(false);
    expect(check({ attribute: 'seats', operator: 'gte', value: 10 }, { seats: 10 })).toBe(true);
    expect(check({ attribute: 'seats', operator: 'lt', value: 10 }, { seats: 9 })).toBe(true);
    expect(check({ attribute: 'seats', operator: 'lte', value: 10 }, { seats: 10 })).toBe(true);
    expect(check({ attribute: 'seats', operator: 'gt', value: 10 }, { seats: '11' })).toBe(false);
  });

  it('handles presence checks', () => {
    expect(check({ attribute: 'beta', operator: 'exists' }, { beta: false })).toBe(true);
    expect(check({ attribute: 'beta', operator: 'exists' }, {})).toBe(false);
    expect(check({ attribute: 'beta', operator: 'notExists' }, {})).toBe(true);
  });

  it('treats notIn on a missing attribute as no match', () => {
    // Fail closed: an absent attribute is not evidence of exclusion.
    expect(check({ attribute: 'plan', operator: 'notIn', value: ['free'] }, {})).toBe(false);
    expect(check({ attribute: 'plan', operator: 'notIn', value: ['free'] }, { plan: 'pro' })).toBe(
      true,
    );
  });

  it('handles string operators', () => {
    expect(
      check({ attribute: 'host', operator: 'contains', value: 'staging' }, { host: 'a-staging-1' }),
    ).toBe(true);
    expect(
      check({ attribute: 'host', operator: 'startsWith', value: 'eu-' }, { host: 'eu-west-1' }),
    ).toBe(true);
    expect(
      check({ attribute: 'email', operator: 'endsWith', value: '@corp.com' }, { email: 'a@b.io' }),
    ).toBe(false);
  });

  it('matches array attributes as sets', () => {
    expect(
      check({ attribute: 'roles', operator: 'in', value: ['admin'] }, { roles: ['a', 'admin'] }),
    ).toBe(true);
    expect(check({ attribute: 'roles', operator: 'in', value: ['admin'] }, { roles: ['a'] })).toBe(
      false,
    );
    expect(
      check({ attribute: 'roles', operator: 'contains', value: 'admin' }, { roles: ['admin'] }),
    ).toBe(true);
  });

  it('reads the targeting key as the reserved attribute name', () => {
    const condition: Condition = { attribute: 'targetingKey', operator: 'in', value: ['user-7'] };
    expect(matchesCondition(condition, { targetingKey: 'user-7' })).toBe(true);
    expect(matchesCondition(condition, { targetingKey: 'user-8' })).toBe(false);
  });

  it('never matches attributes that are not scalars or scalar arrays', () => {
    expect(check({ attribute: 'nested', operator: 'eq', value: 'x' }, { nested: { a: 'x' } })).toBe(
      false,
    );
    expect(
      check({ attribute: 'nested', operator: 'in', value: ['x'] }, { nested: [{ a: 'x' }] }),
    ).toBe(false);
  });

  it('compares versions with the semver operators', () => {
    const gte: Condition = { attribute: 'appVersion', operator: 'semverGte', value: '2.1.0' };
    expect(check(gte, { appVersion: '2.1.0' })).toBe(true);
    expect(check(gte, { appVersion: 'v2.2' })).toBe(true);
    expect(check(gte, { appVersion: '2.1.0-rc.1' })).toBe(false);
    expect(check(gte, { appVersion: 'not-a-version' })).toBe(false);
    expect(
      check(
        { attribute: 'appVersion', operator: 'semverEq', value: '2.1' },
        {
          appVersion: '2.1.0',
        },
      ),
    ).toBe(true);
    expect(
      check(
        { attribute: 'appVersion', operator: 'semverLt', value: '3.0.0' },
        {
          appVersion: '2.9.9',
        },
      ),
    ).toBe(true);
  });
});

describe('segments', () => {
  const betaTesters = compileSegment({
    key: 'beta-testers',
    included: ['user-in'],
    excluded: ['user-out'],
    rules: [
      {
        id: 'internal',
        conditions: [{ attribute: 'email', operator: 'endsWith', value: '@example.com' }],
      },
    ],
  });

  const segments: SegmentMap = new Map([['beta-testers', betaTesters]]);

  it('lets the excluded list veto everything else', () => {
    // user-out would match the rule, but the exclusion is a hard opt-out.
    expect(isInSegment(betaTesters, { targetingKey: 'user-out', email: 'dev@example.com' })).toBe(
      false,
    );
  });

  it('grants membership through the included list', () => {
    expect(isInSegment(betaTesters, { targetingKey: 'user-in' })).toBe(true);
  });

  it('grants membership through the rules, even without a targeting key', () => {
    expect(isInSegment(betaTesters, { email: 'dev@example.com' })).toBe(true);
    expect(isInSegment(betaTesters, { email: 'dev@elsewhere.com' })).toBe(false);
  });

  it('matches inSegment and notInSegment conditions', () => {
    const inCondition: Condition = { operator: 'inSegment', segments: ['beta-testers'] };
    const notCondition: Condition = { operator: 'notInSegment', segments: ['beta-testers'] };

    expect(matchesCondition(inCondition, { targetingKey: 'user-in' }, segments)).toBe(true);
    expect(matchesCondition(inCondition, { targetingKey: 'someone' }, segments)).toBe(false);
    expect(matchesCondition(notCondition, { targetingKey: 'someone' }, segments)).toBe(true);
  });

  it('fails closed on an unknown segment or a missing segment map', () => {
    const condition: Condition = { operator: 'inSegment', segments: ['ghost'] };
    expect(matchesCondition(condition, { targetingKey: 'user-in' }, segments)).toBe(false);
    expect(matchesCondition(condition, { targetingKey: 'user-in' })).toBe(false);
  });

  it('matches any of several segment keys', () => {
    const condition: Condition = { operator: 'inSegment', segments: ['ghost', 'beta-testers'] };
    expect(matchesCondition(condition, { targetingKey: 'user-in' }, segments)).toBe(true);
  });

  it('fails closed on a hand-built segment condition inside a segment rule', () => {
    // The parser rejects this shape; a hand-built one must not recurse.
    const nested = compileSegment({
      key: 'nested',
      rules: [{ id: 'r', conditions: [{ operator: 'inSegment', segments: ['beta-testers'] }] }],
    });

    expect(isInSegment(nested, { targetingKey: 'user-in' })).toBe(false);
  });
});
