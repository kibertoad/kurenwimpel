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
