import { describe, expect, it } from 'vitest';

import { evaluateFlag } from '../../src/index.js';
import type { FlagDefinition } from '../../src/index.js';

const booleanFlag: FlagDefinition<boolean> = {
  key: 'new-checkout',
  enabled: true,
  variants: { on: true, off: false },
  defaultVariant: 'off',
  offVariant: 'off',
};

const users = (count: number): string[] => Array.from({ length: count }, (_, i) => `user-${i}`);

describe('evaluateFlag pipeline', () => {
  it('serves the off variant when disabled, ignoring everything else', () => {
    const result = evaluateFlag(
      {
        ...booleanFlag,
        enabled: false,
        targets: [{ variant: 'on', keys: ['user-1'] }],
        rules: [{ id: 'always', conditions: [], variant: 'on' }],
      },
      { targetingKey: 'user-1' },
    );

    expect(result).toMatchObject({ value: false, variant: 'off', reason: 'DISABLED' });
  });

  it('serves the default variant with STATIC when nothing matches', () => {
    const result = evaluateFlag(booleanFlag, { targetingKey: 'user-1' });
    expect(result).toMatchObject({ value: false, variant: 'off', reason: 'STATIC' });
  });

  it('serves an individually targeted key before any rule', () => {
    const result = evaluateFlag(
      {
        ...booleanFlag,
        targets: [{ variant: 'on', keys: ['qa-account'] }],
        rules: [{ id: 'nobody', conditions: [], variant: 'off' }],
      },
      { targetingKey: 'qa-account' },
    );

    expect(result).toMatchObject({ value: true, variant: 'on', reason: 'TARGETING_MATCH' });
    expect(result.ruleId).toBeUndefined();
  });

  it('serves the first matching rule and reports its id', () => {
    const result = evaluateFlag(
      {
        ...booleanFlag,
        rules: [
          {
            id: 'internal-staff',
            conditions: [{ attribute: 'email', operator: 'endsWith', value: '@lokalise.com' }],
            variant: 'on',
          },
          { id: 'second', conditions: [], variant: 'off' },
        ],
      },
      { targetingKey: 'user-1', email: 'dev@lokalise.com' },
    );

    expect(result).toMatchObject({
      value: true,
      variant: 'on',
      reason: 'TARGETING_MATCH',
      ruleId: 'internal-staff',
    });
  });

  it('treats an empty condition list as an unconditional match', () => {
    const result = evaluateFlag(
      { ...booleanFlag, rules: [{ id: 'all', conditions: [], variant: 'on' }] },
      {},
    );
    expect(result).toMatchObject({ value: true, reason: 'TARGETING_MATCH' });
  });

  it('requires every condition of a rule to hold', () => {
    const flag: FlagDefinition<boolean> = {
      ...booleanFlag,
      rules: [
        {
          id: 'paid-eu',
          conditions: [
            { attribute: 'plan', operator: 'in', value: ['pro', 'enterprise'] },
            { attribute: 'region', operator: 'eq', value: 'eu' },
          ],
          variant: 'on',
        },
      ],
    };

    expect(evaluateFlag(flag, { plan: 'pro', region: 'eu' }).value).toBe(true);
    expect(evaluateFlag(flag, { plan: 'pro', region: 'us' }).value).toBe(false);
  });

  it('errors instead of throwing when a variant is missing', () => {
    const result = evaluateFlag(
      {
        ...booleanFlag,
        rules: [{ id: 'r', conditions: [], variant: 'on' }],
        variants: { off: false },
      },
      {},
    );

    expect(result).toMatchObject({
      value: undefined,
      reason: 'ERROR',
      errorCode: 'VARIANT_NOT_FOUND',
    });
  });

  it('passes flag metadata through to the result', () => {
    const result = evaluateFlag({ ...booleanFlag, metadata: { experiment: 'checkout-q3' } }, {});
    expect(result.metadata).toEqual({ experiment: 'checkout-q3' });
  });
});

describe('rollouts', () => {
  it('splits deterministically and close to the declared weights', () => {
    const flag: FlagDefinition<boolean> = {
      ...booleanFlag,
      rollout: [
        { variant: 'on', weight: 25 },
        { variant: 'off', weight: 75 },
      ],
    };

    const keys = users(20_000);
    const onShare =
      keys.filter((key) => evaluateFlag(flag, { targetingKey: key }).value === true).length /
      keys.length;

    expect(onShare).toBeGreaterThan(0.24);
    expect(onShare).toBeLessThan(0.26);

    const first = evaluateFlag(flag, { targetingKey: 'user-42' });
    expect(evaluateFlag(flag, { targetingKey: 'user-42' })).toEqual(first);
    expect(first.reason).toBe('SPLIT');
  });

  it('keeps a subject in the retained slice when a rollout is widened', () => {
    const at = (weight: number): FlagDefinition<boolean> => ({
      ...booleanFlag,
      rollout: [
        { variant: 'on', weight },
        { variant: 'off', weight: 100 - weight },
      ],
    });

    const flipped = users(2000).filter(
      (key) =>
        evaluateFlag(at(20), { targetingKey: key }).value === true &&
        evaluateFlag(at(50), { targetingKey: key }).value === false,
    );

    expect(flipped).toHaveLength(0);
  });

  it('reports a missing targeting key but still serves the default', () => {
    const result = evaluateFlag({ ...booleanFlag, rollout: [{ variant: 'on', weight: 100 }] }, {});

    expect(result).toMatchObject({
      value: false,
      reason: 'ERROR',
      errorCode: 'TARGETING_KEY_MISSING',
    });
  });

  it('buckets whole cohorts together with bucketBy', () => {
    const flag: FlagDefinition<boolean> = {
      ...booleanFlag,
      rollout: {
        bucketBy: 'accountId',
        buckets: [
          { variant: 'on', weight: 50 },
          { variant: 'off', weight: 50 },
        ],
      },
    };

    const alice = evaluateFlag(flag, { targetingKey: 'alice', accountId: 'acme' });
    const bob = evaluateFlag(flag, { targetingKey: 'bob', accountId: 'acme' });
    expect(alice.variant).toBe(bob.variant);

    // Numbers are accepted as bucketing identities.
    expect(evaluateFlag(flag, { targetingKey: 'x', accountId: 42 }).reason).toBe('SPLIT');
  });

  it('names the missing bucketBy attribute instead of silently bucketing', () => {
    const flag: FlagDefinition<boolean> = {
      ...booleanFlag,
      rollout: { bucketBy: 'accountId', buckets: [{ variant: 'on', weight: 100 }] },
    };

    const result = evaluateFlag(flag, { targetingKey: 'alice' });
    expect(result).toMatchObject({
      value: false,
      reason: 'ERROR',
      errorCode: 'TARGETING_KEY_MISSING',
    });
    expect(result.errorMessage).toContain('accountId');
  });

  it('re-randomises assignment when the seed changes, and only then', () => {
    const seeded = (seed: string): FlagDefinition<boolean> => ({
      ...booleanFlag,
      rollout: {
        seed,
        buckets: [
          { variant: 'on', weight: 50 },
          { variant: 'off', weight: 50 },
        ],
      },
    });

    const keys = users(2000);
    const moved = keys.filter(
      (key) =>
        evaluateFlag(seeded('run-1'), { targetingKey: key }).variant !==
        evaluateFlag(seeded('run-2'), { targetingKey: key }).variant,
    );

    // Two independent 50/50 draws disagree for about half the subjects.
    expect(moved.length).toBeGreaterThan(keys.length * 0.4);
    expect(moved.length).toBeLessThan(keys.length * 0.6);

    expect(evaluateFlag(seeded('run-1'), { targetingKey: 'user-7' })).toEqual(
      evaluateFlag(seeded('run-1'), { targetingKey: 'user-7' }),
    );
  });

  it('serves a rule-level rollout with the rule id attached', () => {
    const result = evaluateFlag(
      {
        ...booleanFlag,
        rules: [
          {
            id: 'paid-ramp',
            conditions: [{ attribute: 'plan', operator: 'eq', value: 'pro' }],
            rollout: [{ variant: 'on', weight: 100 }],
          },
        ],
      },
      { targetingKey: 'user-1', plan: 'pro' },
    );

    expect(result).toMatchObject({ value: true, reason: 'SPLIT', ruleId: 'paid-ramp' });
  });
});

describe('traffic allocation', () => {
  const experiment: FlagDefinition<boolean> = {
    ...booleanFlag,
    allocation: { percent: 20 },
    rollout: [
      { variant: 'on', weight: 50 },
      { variant: 'off', weight: 50 },
    ],
  };

  it('serves NOT_ALLOCATED outside the allocation and SPLIT inside it', () => {
    const keys = users(10_000);
    const results = keys.map((key) => evaluateFlag(experiment, { targetingKey: key }));

    const admitted = results.filter((result) => result.reason === 'SPLIT');
    const excluded = results.filter((result) => result.reason === 'NOT_ALLOCATED');

    expect(admitted.length + excluded.length).toBe(keys.length);
    expect(admitted.length / keys.length).toBeGreaterThan(0.18);
    expect(admitted.length / keys.length).toBeLessThan(0.22);

    // Everyone outside the experiment gets the default variant.
    expect(excluded.every((result) => result.variant === 'off')).toBe(true);

    // The admitted population still splits by the declared weights.
    const onShare = admitted.filter((result) => result.value === true).length / admitted.length;
    expect(onShare).toBeGreaterThan(0.45);
    expect(onShare).toBeLessThan(0.55);
  });

  it('keeps treatments stable when the allocation is widened', () => {
    const wider: FlagDefinition<boolean> = { ...experiment, allocation: { percent: 60 } };

    for (const key of users(3000)) {
      const before = evaluateFlag(experiment, { targetingKey: key });
      const after = evaluateFlag(wider, { targetingKey: key });

      // Nobody leaves, and nobody already admitted changes treatment.
      if (before.reason === 'SPLIT') {
        expect(after.reason).toBe('SPLIT');
        expect(after.variant).toBe(before.variant);
      }
    }
  });

  it('lets individual targets bypass the allocation entirely', () => {
    const flag: FlagDefinition<boolean> = {
      ...experiment,
      allocation: { percent: 0 },
      targets: [{ variant: 'on', keys: ['qa-account'] }],
    };

    expect(evaluateFlag(flag, { targetingKey: 'qa-account' })).toMatchObject({
      value: true,
      reason: 'TARGETING_MATCH',
    });
    expect(evaluateFlag(flag, { targetingKey: 'someone-else' }).reason).toBe('NOT_ALLOCATED');
  });

  it('reports a missing targeting key when an allocation needs one', () => {
    const result = evaluateFlag(experiment, {});
    expect(result).toMatchObject({
      value: false,
      reason: 'ERROR',
      errorCode: 'TARGETING_KEY_MISSING',
    });
  });
});
