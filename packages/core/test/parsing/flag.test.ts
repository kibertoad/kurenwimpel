import { describe, expect, it } from 'vitest';

import { FlagParseError, parseFlagDefinition } from '../../src/index.js';

const valid = {
  key: 'new-checkout',
  enabled: true,
  variants: { on: true, off: false },
  defaultVariant: 'off',
  offVariant: 'off',
};

describe('parseFlagDefinition', () => {
  it('accepts a minimal definition', () => {
    expect(parseFlagDefinition(valid)).toEqual(valid);
  });

  it('keeps optional fields only when present', () => {
    const parsed = parseFlagDefinition(valid);
    for (const field of ['rules', 'salt', 'targets', 'allocation', 'prerequisites', 'metadata']) {
      expect(Object.hasOwn(parsed, field)).toBe(false);
    }
  });

  it('parses rules, conditions, and rollouts', () => {
    const parsed = parseFlagDefinition({
      ...valid,
      salt: 'v2',
      version: 3,
      metadata: { experiment: 'checkout-q3' },
      rules: [
        {
          id: 'beta-testers',
          conditions: [
            { attribute: 'plan', operator: 'in', value: ['pro', 'enterprise'] },
            { attribute: 'seats', operator: 'gte', value: 10 },
            { attribute: 'appVersion', operator: 'semverGte', value: '2.1.0' },
            { operator: 'inSegment', segments: ['beta-testers'] },
          ],
          rollout: [
            { variant: 'on', weight: 50 },
            { variant: 'off', weight: 50 },
          ],
        },
      ],
    });

    expect(parsed.salt).toBe('v2');
    expect(parsed.version).toBe(3);
    expect(parsed.metadata).toEqual({ experiment: 'checkout-q3' });
    expect(parsed.rules?.[0]?.conditions).toHaveLength(4);
  });

  it('parses the full experiment surface: targets, allocation, split rollout', () => {
    const parsed = parseFlagDefinition({
      ...valid,
      targets: [{ variant: 'on', keys: ['qa-1', 'qa-2'] }],
      allocation: { percent: 20, seed: 'run-2' },
      prerequisites: [{ flag: 'new-backend', variants: ['on'] }],
      rollout: {
        bucketBy: 'accountId',
        seed: 'iteration-3',
        buckets: [
          { variant: 'on', weight: 50 },
          { variant: 'off', weight: 50 },
        ],
      },
    });

    expect(parsed.targets).toEqual([{ variant: 'on', keys: ['qa-1', 'qa-2'] }]);
    expect(parsed.allocation).toEqual({ percent: 20, seed: 'run-2' });
    expect(parsed.prerequisites).toEqual([{ flag: 'new-backend', variants: ['on'] }]);
    expect(parsed.rollout).toMatchObject({ bucketBy: 'accountId', seed: 'iteration-3' });
  });

  it.each([
    ['a non-object', 42],
    ['a missing key', { ...valid, key: undefined }],
    ['an empty key', { ...valid, key: '' }],
    ['a non-boolean enabled', { ...valid, enabled: 'yes' }],
    ['missing variants', { ...valid, variants: undefined }],
    ['empty variants', { ...valid, variants: {} }],
    ['a dangling defaultVariant', { ...valid, defaultVariant: 'nope' }],
    ['a dangling offVariant', { ...valid, offVariant: 'nope' }],
  ])('rejects %s', (_label, input) => {
    expect(() => parseFlagDefinition(input)).toThrow(FlagParseError);
  });

  it.each([
    ['null', null],
    ['an array', [1, 2, 3]],
    ['NaN', Number.NaN],
  ])('rejects %s as a variant value — OFREP cannot carry it', (_label, value) => {
    expect(() =>
      parseFlagDefinition({ ...valid, variants: { on: true, off: false, odd: value } }),
    ).toThrow(FlagParseError);
  });

  it('rejects a rule that serves nothing', () => {
    expect(() => parseFlagDefinition({ ...valid, rules: [{ id: 'r', conditions: [] }] })).toThrow(
      /must declare a variant or a rollout/u,
    );
  });

  it('rejects unknown variant references from rules, targets, and rollouts', () => {
    expect(() =>
      parseFlagDefinition({ ...valid, rules: [{ id: 'r', conditions: [], variant: 'ghost' }] }),
    ).toThrow(/unknown variant/u);
    expect(() =>
      parseFlagDefinition({ ...valid, targets: [{ variant: 'ghost', keys: ['u'] }] }),
    ).toThrow(/unknown variant/u);
    expect(() =>
      parseFlagDefinition({ ...valid, rollout: [{ variant: 'ghost', weight: 1 }] }),
    ).toThrow(/unknown variant/u);
  });

  it('rejects an unsupported operator', () => {
    expect(() =>
      parseFlagDefinition({
        ...valid,
        rules: [
          {
            id: 'r',
            conditions: [{ attribute: 'a', operator: 'regex', value: '.*' }],
            variant: 'on',
          },
        ],
      }),
    ).toThrow(/unsupported operator/u);
  });

  it('rejects an operator whose value has the wrong type', () => {
    const withCondition = (condition: unknown): unknown => ({
      ...valid,
      rules: [{ id: 'r', conditions: [condition], variant: 'on' }],
    });

    expect(() =>
      parseFlagDefinition(withCondition({ attribute: 'a', operator: 'gt', value: 'ten' })),
    ).toThrow(/needs a finite number/u);
    expect(() =>
      parseFlagDefinition(withCondition({ attribute: 'a', operator: 'in', value: 'pro' })),
    ).toThrow(/needs an array/u);
    expect(() =>
      parseFlagDefinition(withCondition({ attribute: 'a', operator: 'semverGte', value: 'nope' })),
    ).toThrow(/semantic version/u);
    expect(() =>
      parseFlagDefinition(withCondition({ operator: 'inSegment', segments: [] })),
    ).toThrow(/at least one segment/u);
  });

  it('rejects a negative rollout weight and an all-zero split', () => {
    expect(() =>
      parseFlagDefinition({ ...valid, rollout: [{ variant: 'on', weight: -1 }] }),
    ).toThrow(/non-negative/u);
    expect(() =>
      parseFlagDefinition({ ...valid, rollout: [{ variant: 'on', weight: 0 }] }),
    ).toThrow(/more than zero/u);
  });

  it('drops an empty rollout array rather than producing an unservable split', () => {
    expect(parseFlagDefinition({ ...valid, rollout: [] }).rollout).toBeUndefined();
  });

  it('rejects a targeting key claimed by two targets', () => {
    expect(() =>
      parseFlagDefinition({
        ...valid,
        targets: [
          { variant: 'on', keys: ['u1'] },
          { variant: 'off', keys: ['u1'] },
        ],
      }),
    ).toThrow(/more than one target/u);
  });

  it('rejects an out-of-range allocation and a self-prerequisite', () => {
    expect(() => parseFlagDefinition({ ...valid, allocation: { percent: 101 } })).toThrow(
      /between 0 and 100/u,
    );
    expect(() =>
      parseFlagDefinition({
        ...valid,
        prerequisites: [{ flag: 'new-checkout', variants: ['on'] }],
      }),
    ).toThrow(/own prerequisite/u);
  });

  it('rejects non-scalar metadata values', () => {
    expect(() => parseFlagDefinition({ ...valid, metadata: { nested: {} } })).toThrow(
      /metadata nested/u,
    );
  });
});
