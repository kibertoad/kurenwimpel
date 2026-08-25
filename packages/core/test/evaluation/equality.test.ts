/**
 * What the equality and set operators agree on.
 *
 * `eq`/`neq` and `in`/`notIn` ask the same question of the same attribute, so
 * an attribute they answer differently about is a defect in one of them —
 * whichever way round it reads. Two shapes used to split them: an array-valued
 * attribute, which only the set pair treated as a set, and a targeting key,
 * which the context side resolves to an identity and the operand side did not.
 */

import { describe, expect, it } from 'vitest';

import { evaluateFlag, matchesCondition, parseFlagDefinition } from '../../src/index.js';
import type { Condition, EvaluationContext, FlagDefinition } from '../../src/index.js';

const matches = (condition: Condition, context: EvaluationContext): boolean =>
  matchesCondition(condition, context);

const eq = (attribute: string, value: string | number | boolean): Condition => ({
  attribute,
  operator: 'eq',
  value,
});
const neq = (attribute: string, value: string | number | boolean): Condition => ({
  attribute,
  operator: 'neq',
  value,
});
const inList = (attribute: string, value: (string | number)[]): Condition => ({
  attribute,
  operator: 'in',
  value,
});
const notIn = (attribute: string, value: (string | number)[]): Condition => ({
  attribute,
  operator: 'notIn',
  value,
});

describe('an array-valued attribute is a set to every operator that has a set reading', () => {
  const admin = { targetingKey: 'u1', roles: ['admin', 'billing'] };

  it('matches eq and in on an element, and neither neq nor notIn', () => {
    // `neq` was the one matcher in the module that failed open: it read the
    // whole array as "not 'admin'" and matched, so a rule written to keep
    // admins out of a rollout targeted exactly them — while `notIn: ['admin']`,
    // the same question in the other spelling, kept them out.
    expect(matches(eq('roles', 'admin'), admin)).toBe(true);
    expect(matches(inList('roles', ['admin']), admin)).toBe(true);
    expect(matches(neq('roles', 'admin'), admin)).toBe(false);
    expect(matches(notIn('roles', ['admin']), admin)).toBe(false);
  });

  it('answers the other way for a value no element carries', () => {
    expect(matches(eq('roles', 'owner'), admin)).toBe(false);
    expect(matches(inList('roles', ['owner']), admin)).toBe(false);
    expect(matches(neq('roles', 'owner'), admin)).toBe(true);
    expect(matches(notIn('roles', ['owner']), admin)).toBe(true);
  });

  it('agrees with the single-valued form of the same attribute', () => {
    // An operator has to mean the same thing whatever shape the attribute
    // happens to have — the rule `contains` already followed.
    const single = { targetingKey: 'u1', roles: 'admin' };

    for (const condition of [eq('roles', 'admin'), neq('roles', 'admin')]) {
      expect(matches(condition, admin)).toBe(matches(condition, single));
    }
  });

  it('keeps eq and neq exact opposites wherever the attribute is present', () => {
    const contexts: EvaluationContext[] = [
      { roles: ['admin'] },
      { roles: [] },
      { roles: 'admin' },
      { roles: 'owner' },
      { roles: 7 },
      { roles: true },
      { roles: null },
      { roles: { name: 'admin' } },
    ];

    for (const context of contexts) {
      expect(matches(eq('roles', 'admin'), context)).toBe(!matches(neq('roles', 'admin'), context));
    }
  });

  it('still fails closed on both sides when the attribute is absent', () => {
    // An absent attribute is not evidence of equality or of inequality.
    expect(matches(eq('roles', 'admin'), { targetingKey: 'u1' })).toBe(false);
    expect(matches(neq('roles', 'admin'), { targetingKey: 'u1' })).toBe(false);
  });

  it('leaves the operators with no set reading matching nothing', () => {
    const versions = { appVersion: ['2.4.1'], seats: [50] };

    expect(matches({ attribute: 'seats', operator: 'gt', value: 10 }, versions)).toBe(false);
    expect(
      matches({ attribute: 'appVersion', operator: 'startsWith', value: '2.' }, versions),
    ).toBe(false);
    expect(
      matches({ attribute: 'appVersion', operator: 'semverGte', value: '2.4.0' }, versions),
    ).toBe(false);
  });
});

describe('a targeting key compares as the identity it is bucketed as', () => {
  // A numeric id column is the ordinary source of a targeting key, and a
  // control plane reading the operand off the same column writes `eq: 42`.
  // Untranslated, that rule matched nobody at all while its `neq` twin matched
  // everybody — the one subject it names included.
  const numeric = { targetingKey: 42 } as unknown as EvaluationContext;

  it('matches a numeric operand against a numeric key', () => {
    expect(matches(eq('targetingKey', 42), numeric)).toBe(true);
    expect(matches(neq('targetingKey', 42), numeric)).toBe(false);
    expect(matches(inList('targetingKey', [41, 42]), numeric)).toBe(true);
    expect(matches(notIn('targetingKey', [41, 42]), numeric)).toBe(false);
  });

  it('matches the string spelling of the same key just as well', () => {
    expect(matches(eq('targetingKey', '42'), numeric)).toBe(true);
    expect(matches(eq('targetingKey', 42), { targetingKey: '42' })).toBe(true);
    expect(matches(inList('targetingKey', ['42']), numeric)).toBe(true);
  });

  it('fails closed on an operand no targeting key could ever be', () => {
    // A boolean is not an identity, so nothing can equal it — and `neq` must
    // not answer "true, then" for every subject alive.
    expect(matches(eq('targetingKey', true), numeric)).toBe(false);
    expect(matches(neq('targetingKey', true), numeric)).toBe(false);
    expect(matches(eq('targetingKey', ''), { targetingKey: 'u1' })).toBe(false);
    expect(matches(neq('targetingKey', ''), { targetingKey: 'u1' })).toBe(false);
  });

  it('leaves every other attribute reading exactly what the context holds', () => {
    // Only the targeting key is always an identity; `plan: 42` is an ordinary
    // numeric attribute and must not be compared as the string "42".
    expect(matches(eq('plan', '42'), { plan: 42 })).toBe(false);
    expect(matches(eq('plan', 42), { plan: 42 })).toBe(true);
    expect(matches(eq('plan', ''), { plan: '' })).toBe(true);
    expect(matches(neq('plan', ''), { plan: '' })).toBe(false);
  });

  it('decides a real rollout the same way, end to end', () => {
    const flag: FlagDefinition = parseFlagDefinition({
      key: 'staff-tools',
      enabled: true,
      variants: { on: true, off: false },
      defaultVariant: 'off',
      offVariant: 'off',
      rules: [
        {
          id: 'not-the-demo-tenant',
          conditions: [{ attribute: 'targetingKey', operator: 'neq', value: 7 }],
          variant: 'on',
        },
      ],
    });

    const seven = { targetingKey: 7 } as unknown as EvaluationContext;
    expect(evaluateFlag(flag, seven).value).toBe(false);
    expect(evaluateFlag(flag, { targetingKey: '8' }).value).toBe(true);
  });
});
