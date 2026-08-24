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

  it('treats neq on a missing attribute as no match', () => {
    // Fail closed, same as notIn: an anonymous context is not "not on free".
    expect(check({ attribute: 'plan', operator: 'neq', value: 'free' }, {})).toBe(false);
    expect(check({ attribute: 'plan', operator: 'neq', value: 'free' }, { plan: 'pro' })).toBe(
      true,
    );
    expect(check({ attribute: 'plan', operator: 'neq', value: 'free' }, { plan: 'free' })).toBe(
      false,
    );
  });

  it('reads only own properties, never the prototype chain', () => {
    // 'constructor' and 'toString' resolve on Object.prototype for any plain
    // object; targeting must see them as absent.
    expect(check({ attribute: 'constructor', operator: 'exists' }, {})).toBe(false);
    expect(check({ attribute: 'toString', operator: 'notExists' }, {})).toBe(true);
    expect(check({ attribute: 'constructor', operator: 'neq', value: 'x' }, {})).toBe(false);
    // An own property by those names still works.
    expect(
      check(
        { attribute: 'constructor', operator: 'eq', value: 'v' },
        JSON.parse('{"constructor":"v"}') as Record<string, string>,
      ),
    ).toBe(true);
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

  it('fails notInSegment closed too: an unresolvable segment matches no one', () => {
    // The rule was written to exclude an audience; if that audience cannot be
    // resolved, matching everyone is the one wrong answer.
    const condition: Condition = { operator: 'notInSegment', segments: ['ghost'] };
    expect(matchesCondition(condition, { targetingKey: 'someone' }, segments)).toBe(false);
    expect(matchesCondition(condition, { targetingKey: 'someone' })).toBe(false);

    // Proven membership in a resolvable segment still decides it, though.
    const mixed: Condition = { operator: 'notInSegment', segments: ['ghost', 'beta-testers'] };
    expect(matchesCondition(mixed, { targetingKey: 'user-in' }, segments)).toBe(false);
    // Non-member of the known segment, but 'ghost' stays undecidable: no match.
    expect(matchesCondition(mixed, { targetingKey: 'someone' }, segments)).toBe(false);
  });

  it('matches any of several segment keys', () => {
    const condition: Condition = { operator: 'inSegment', segments: ['ghost', 'beta-testers'] };
    expect(matchesCondition(condition, { targetingKey: 'user-in' }, segments)).toBe(true);
  });

  it('treats an empty targeting key as no identity for the include lists', () => {
    const withEmpty = compileSegment({ key: 'odd', included: [''] });
    expect(isInSegment(withEmpty, { targetingKey: '' })).toBe(false);
  });

  it('fails closed on a hand-built segment condition inside a segment rule', () => {
    // The parser rejects this shape; a hand-built one must not recurse.
    const nested = compileSegment({
      key: 'nested',
      rules: [{ id: 'r', conditions: [{ operator: 'inSegment', segments: ['beta-testers'] }] }],
    });

    expect(isInSegment(nested, { targetingKey: 'user-in' })).toBe(false);

    // The negated form must fail closed the same way, not match everyone.
    const negated = compileSegment({
      key: 'negated',
      rules: [{ id: 'r', conditions: [{ operator: 'notInSegment', segments: ['beta-testers'] }] }],
    });

    expect(isInSegment(negated, { targetingKey: 'someone' })).toBe(false);
  });
});

// The type says `value` is a list, but hand-built and JSON-cast definitions bypass
// the parser — the same path every other guard in this module exists for.
// `list.includes` on a string is substring matching, so trusting the type turned
// `plan in ['pro']` into "any plan spelled inside 'pro'".
const scalar = (operator: 'in' | 'notIn'): Condition =>
  ({ attribute: 'plan', operator, value: 'pro' }) as unknown as Condition;

describe('list operators with a malformed value', () => {
  it('never substring-matches a scalar standing in for a list', () => {
    expect(check(scalar('in'), { plan: 'p' })).toBe(false);
    expect(check(scalar('in'), { plan: 'ro' })).toBe(false);
    expect(check(scalar('in'), { plan: 'pro' })).toBe(false);
  });

  it('fails closed on both operators, so notIn does not match the whole world', () => {
    // The dangerous direction: an undecidable list must not read as "not a
    // member of anything" and turn the rule on for everyone it excluded.
    expect(check(scalar('notIn'), { plan: 'p' })).toBe(false);
    expect(check(scalar('notIn'), { plan: 'enterprise' })).toBe(false);
  });

  it('still decides both operators for a well-formed list', () => {
    expect(check({ attribute: 'plan', operator: 'in', value: ['pro'] }, { plan: 'pro' })).toBe(
      true,
    );
    expect(check({ attribute: 'plan', operator: 'notIn', value: ['pro'] }, { plan: 'free' })).toBe(
      true,
    );
    // An attribute of a type no list can hold is out of the set, not unanswerable.
    expect(check({ attribute: 'plan', operator: 'notIn', value: ['pro'] }, { plan: true })).toBe(
      true,
    );
  });
});

describe('the targeting key is read like every other attribute', () => {
  it('does not resolve an inherited targeting key for segment membership', () => {
    // A split used to bucket on a prototype-inherited key while `exists` said
    // the same context had none. One identity, one answer.
    const context = Object.create({ targetingKey: 'inherited' }) as Record<string, AttributeValue>;
    const segment = compileSegment({ key: 'beta', included: ['inherited'] });

    expect(isInSegment(segment, context)).toBe(false);
    expect(check({ attribute: 'targetingKey', operator: 'exists' }, context)).toBe(false);
  });

  it('still resolves an own targeting key', () => {
    const segment = compileSegment({ key: 'beta', included: ['u-1'] });
    expect(isInSegment(segment, { targetingKey: 'u-1' })).toBe(true);
  });
});
