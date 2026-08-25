/**
 * The edges of the operator matrix that decide between "just in" and "just
 * out": comparison boundaries, the operators of the semver family that only
 * differ at equality, and the identity rule at its numeric fringes. Each of
 * these is one flipped comparison away from serving the wrong cohort.
 */

import { describe, expect, it } from 'vitest';

import { matchesCondition } from '../../src/index.js';
import type { Condition, EvaluationContext } from '../../src/index.js';

const check = (condition: Condition, context: EvaluationContext): boolean =>
  matchesCondition(condition, context);

describe('number operators at their boundaries', () => {
  it('keeps the strict pair strict and the inclusive pair inclusive at equality', () => {
    expect(check({ attribute: 'seats', operator: 'gt', value: 10 }, { seats: 10 })).toBe(false);
    expect(check({ attribute: 'seats', operator: 'gte', value: 10 }, { seats: 10 })).toBe(true);
    expect(check({ attribute: 'seats', operator: 'lt', value: 10 }, { seats: 10 })).toBe(false);
    expect(check({ attribute: 'seats', operator: 'lte', value: 10 }, { seats: 10 })).toBe(true);
  });

  it('answers each operator on both sides of the bound', () => {
    expect(check({ attribute: 'seats', operator: 'gt', value: 10 }, { seats: 11 })).toBe(true);
    expect(check({ attribute: 'seats', operator: 'gte', value: 10 }, { seats: 9 })).toBe(false);
    expect(check({ attribute: 'seats', operator: 'lt', value: 10 }, { seats: 11 })).toBe(false);
    expect(check({ attribute: 'seats', operator: 'lte', value: 10 }, { seats: 11 })).toBe(false);
  });
});

describe('semver operators at their boundaries', () => {
  const at = (
    operator: 'semverEq' | 'semverGt' | 'semverGte' | 'semverLt' | 'semverLte',
    appVersion: string,
  ): boolean => check({ attribute: 'appVersion', operator, value: '2.1.0' }, { appVersion });

  it('decides every operator for a version below, at, and above the bound', () => {
    expect(at('semverEq', '2.0.9')).toBe(false);
    expect(at('semverEq', '2.1.0')).toBe(true);
    expect(at('semverEq', '2.1.1')).toBe(false);

    expect(at('semverGt', '2.0.9')).toBe(false);
    expect(at('semverGt', '2.1.0')).toBe(false);
    expect(at('semverGt', '2.1.1')).toBe(true);

    expect(at('semverGte', '2.0.9')).toBe(false);
    expect(at('semverGte', '2.1.0')).toBe(true);
    expect(at('semverGte', '2.1.1')).toBe(true);

    expect(at('semverLt', '2.0.9')).toBe(true);
    expect(at('semverLt', '2.1.0')).toBe(false);
    expect(at('semverLt', '2.1.1')).toBe(false);

    expect(at('semverLte', '2.0.9')).toBe(true);
    expect(at('semverLte', '2.1.0')).toBe(true);
    expect(at('semverLte', '2.1.1')).toBe(false);
  });

  it('fails every semver operator closed on a value that is not a version', () => {
    expect(at('semverGt', 'not-a-version')).toBe(false);
    expect(at('semverLte', 'not-a-version')).toBe(false);
  });
});

describe('an operator this version does not know', () => {
  it('fails closed instead of matching', () => {
    // A newer control plane can ship one; "flag quietly on for everyone" is
    // the failure mode the matcher must not have.
    const future = {
      attribute: 'plan',
      operator: 'matchesGlob',
      value: '*',
    } as unknown as Condition;
    expect(check(future, { plan: 'pro' })).toBe(false);
  });
});

describe('notExists against a present attribute', () => {
  it('does not match when the attribute is there', () => {
    expect(check({ attribute: 'beta', operator: 'notExists' }, { beta: false })).toBe(false);
    expect(check({ attribute: 'beta', operator: 'notExists' }, { beta: '' })).toBe(false);
  });
});

describe('the identity rule at its numeric fringes', () => {
  it('reads a non-finite numeric targeting key as no identity at all', () => {
    // NaN and Infinity have no stable string spelling a target list could
    // name, so they are not identities — here or on any bucketed path.
    const nan = { targetingKey: Number.NaN } as unknown as EvaluationContext;
    const infinite = { targetingKey: Number.POSITIVE_INFINITY } as unknown as EvaluationContext;

    expect(check({ attribute: 'targetingKey', operator: 'exists' }, nan)).toBe(false);
    expect(check({ attribute: 'targetingKey', operator: 'exists' }, infinite)).toBe(false);
    expect(check({ attribute: 'targetingKey', operator: 'notExists' }, nan)).toBe(true);
  });

  it('translates targeting-key list entries through the same rule', () => {
    // The operand side travels identityOf too: numeric entries name the same
    // identity as their string spelling, and unusable entries name nobody.
    const inList: Condition = { attribute: 'targetingKey', operator: 'in', value: [42] };
    expect(check(inList, { targetingKey: '42' })).toBe(true);
    expect(check(inList, { targetingKey: '43' })).toBe(false);

    const empty = {
      attribute: 'targetingKey',
      operator: 'in',
      value: [''],
    } as unknown as Condition;
    expect(check(empty, { targetingKey: 'x' })).toBe(false);
  });
});

describe('set operators over mixed arrays', () => {
  it('skips elements no list could hold and still matches on the scalar ones', () => {
    const condition: Condition = { attribute: 'roles', operator: 'in', value: ['admin'] };
    expect(check(condition, { roles: [{ nested: true }, 'admin'] })).toBe(true);
    expect(check(condition, { roles: [{ nested: true }, null, true] })).toBe(false);
  });

  it('answers notIn for an array attribute whose scalars are all outside the list', () => {
    const condition: Condition = { attribute: 'roles', operator: 'notIn', value: ['admin'] };
    expect(check(condition, { roles: ['billing', 'support'] })).toBe(true);
    expect(check(condition, { roles: ['billing', 'admin'] })).toBe(false);
  });
});
