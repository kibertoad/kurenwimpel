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

  it('never serves a variant resolved through the prototype chain', () => {
    // A hand-built flag naming a variant 'constructor' must be
    // VARIANT_NOT_FOUND, not Object.prototype.constructor served as a value.
    const result = evaluateFlag({ ...booleanFlag, defaultVariant: 'constructor' });

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

  it('falls through to the default variant when a split carries no weight', () => {
    // A parked experiment: all-zero weights serve the default rather than
    // dropping the flag or erroring.
    const result = evaluateFlag(
      {
        ...booleanFlag,
        rollout: [
          { variant: 'on', weight: 0 },
          { variant: 'off', weight: 0 },
        ],
      },
      { targetingKey: 'user-1' },
    );

    expect(result).toMatchObject({ value: false, variant: 'off', reason: 'STATIC' });
  });

  it('treats a weight total that overflows to Infinity as unusable', () => {
    // Hand-built flags bypass the parser; the split must not silently route
    // every subject to the last bucket.
    const result = evaluateFlag(
      {
        ...booleanFlag,
        rollout: [
          { variant: 'on', weight: 1e308 },
          { variant: 'off', weight: 1e308 },
        ],
      },
      { targetingKey: 'user-1' },
    );

    expect(result).toMatchObject({ variant: 'off', reason: 'STATIC' });
  });

  it('gives rule-level rollouts a domain no flag-level rollout can collide with', () => {
    // Under the old ':'-delimited scheme, rule 'r1' of a flag salted 'f'
    // shared its hash domain with a whole flag salted 'f:r1'.
    const ruled: FlagDefinition<boolean> = {
      ...booleanFlag,
      salt: 'f',
      rules: [
        {
          id: 'r1',
          conditions: [],
          rollout: [
            { variant: 'on', weight: 50 },
            { variant: 'off', weight: 50 },
          ],
        },
      ],
    };
    const salted: FlagDefinition<boolean> = {
      ...booleanFlag,
      salt: 'f:r1',
      rollout: [
        { variant: 'on', weight: 50 },
        { variant: 'off', weight: 50 },
      ],
    };

    const agreeing = users(200).filter(
      (key) =>
        evaluateFlag(ruled, { targetingKey: key }).variant ===
        evaluateFlag(salted, { targetingKey: key }).variant,
    );

    // Independent 50/50 draws agree for about half the subjects, not all.
    expect(agreeing.length).toBeGreaterThan(60);
    expect(agreeing.length).toBeLessThan(140);
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
