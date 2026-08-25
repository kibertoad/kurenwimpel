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

describe('traffic allocation', () => {
  const experiment: FlagDefinition<boolean> = {
    ...booleanFlag,
    allocation: { percent: 20 },
    rollout: [
      { variant: 'on', weight: 50 },
      { variant: 'off', weight: 50 },
    ],
  };

  it('settles a gate whose percentage rounds to no buckets, without asking for a key', () => {
    // percent has 0.01 granularity, so 0.001 rounds down to a threshold of
    // zero buckets and the gate admits nobody. Settling it against 0 alone let
    // an operator who typed 0.001 for 0 turn every anonymous and service
    // context into a reported TARGETING_KEY_MISSING, on a gate that was closed
    // either way.
    const parked: FlagDefinition<boolean> = { ...booleanFlag, allocation: { percent: 0.001 } };

    expect(evaluateFlag(parked, {})).toMatchObject({ variant: 'off', reason: 'NOT_ALLOCATED' });
    expect(evaluateFlag(parked, { targetingKey: 'user-1' })).toMatchObject({
      variant: 'off',
      reason: 'NOT_ALLOCATED',
    });
  });

  it('settles the other end the same way: a percentage that rounds to every bucket', () => {
    const finished: FlagDefinition<boolean> = { ...booleanFlag, allocation: { percent: 99.9999 } };

    expect(evaluateFlag(finished, {})).toMatchObject({ variant: 'off', reason: 'STATIC' });
  });

  it('admits everyone at 100 percent without asking for a targeting key', () => {
    const finished: FlagDefinition<boolean> = {
      ...booleanFlag,
      allocation: { percent: 100 },
      rules: [
        {
          id: 'pro',
          conditions: [{ attribute: 'plan', operator: 'eq', value: 'pro' }],
          variant: 'on',
        },
      ],
    };

    // A gate that admits everyone hashes nothing, so it needs no identity to
    // hash. Demanding one would break every anonymous or service-context
    // lookup the moment a finished experiment is ramped to 100.
    expect(evaluateFlag(finished, { plan: 'pro' })).toMatchObject({
      value: true,
      variant: 'on',
      reason: 'TARGETING_MATCH',
      ruleId: 'pro',
    });
    expect(evaluateFlag(finished, { plan: 'free' })).toMatchObject({
      variant: 'off',
      reason: 'STATIC',
    });
  });

  it('excludes everyone at 0 percent without asking for a targeting key', () => {
    const parked: FlagDefinition<boolean> = {
      ...booleanFlag,
      allocation: { percent: 0 },
      rules: [{ id: 'all', conditions: [], variant: 'on' }],
    };

    expect(evaluateFlag(parked, { plan: 'pro' })).toMatchObject({
      value: false,
      variant: 'off',
      reason: 'NOT_ALLOCATED',
    });
    expect(evaluateFlag(parked, { plan: 'pro' }).errorCode).toBeUndefined();
  });

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

  it('treats an empty-string targeting key as missing, consistently', () => {
    // The gate, the split, and individual targets must agree on what counts
    // as an identity; '' is not one anywhere.
    const result = evaluateFlag(experiment, { targetingKey: '' });
    expect(result).toMatchObject({
      value: false,
      reason: 'ERROR',
      errorCode: 'TARGETING_KEY_MISSING',
    });

    const targeted: FlagDefinition<boolean> = {
      ...booleanFlag,
      targets: [{ variant: 'on', keys: [''] }],
    };
    expect(evaluateFlag(targeted, { targetingKey: '' }).reason).toBe('STATIC');
  });

  it('keeps the admitted split unbiased when the rollout is seeded "allocation"', () => {
    // Regression: the old delimiter scheme collapsed this seed onto the
    // allocation gate's domain, sending 100% of admitted traffic to one arm.
    const seeded: FlagDefinition<boolean> = {
      ...booleanFlag,
      allocation: { percent: 50 },
      rollout: {
        seed: 'allocation',
        buckets: [
          { variant: 'on', weight: 50 },
          { variant: 'off', weight: 50 },
        ],
      },
    };

    const admitted = users(10_000)
      .map((key) => evaluateFlag(seeded, { targetingKey: key }))
      .filter((result) => result.reason === 'SPLIT');

    const onShare = admitted.filter((result) => result.value === true).length / admitted.length;
    expect(onShare).toBeGreaterThan(0.45);
    expect(onShare).toBeLessThan(0.55);
  });
});

describe('allocation bucketed on an attribute', () => {
  const buckets = [
    { variant: 'on', weight: 50 },
    { variant: 'off', weight: 50 },
  ];
  const cohort = users(20).map((key) => ({ targetingKey: key, accountId: 'acme' }));
  const reasonsFor = (flag: FlagDefinition<boolean>): Set<string> =>
    new Set(cohort.map((context) => evaluateFlag(flag, context).reason));

  it('admits or excludes a whole cohort, where the default gate splits it', () => {
    // The gate hashes the targeting key by default, so an account can be half
    // admitted even when assignment clusters it — pointing both knobs at the
    // same attribute is how an operator gets the whole-account flip.
    const perUser: FlagDefinition<boolean> = {
      ...booleanFlag,
      allocation: { percent: 50 },
      rollout: { bucketBy: 'accountId', buckets },
    };
    const perAccount: FlagDefinition<boolean> = {
      ...booleanFlag,
      allocation: { percent: 50, bucketBy: 'accountId' },
      rollout: { bucketBy: 'accountId', buckets },
    };

    expect(reasonsFor(perUser).size).toBeGreaterThan(1);
    expect(reasonsFor(perAccount).size).toBe(1);
  });

  it('names the attribute it needed when the cohort key is absent', () => {
    const flag: FlagDefinition<boolean> = {
      ...booleanFlag,
      allocation: { percent: 50, bucketBy: 'accountId' },
    };

    const result = evaluateFlag(flag, { targetingKey: 'alice' });
    expect(result).toMatchObject({ reason: 'ERROR', errorCode: 'TARGETING_KEY_MISSING' });
    expect(result.errorMessage).toContain('accountId');
  });
});
