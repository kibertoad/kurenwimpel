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

  it('normalises relative weights rather than requiring them to sum to 100', () => {
    // The documented promise: [{on, 1}, {off, 3}] is a 25/75 split.
    const flag: FlagDefinition<boolean> = {
      ...booleanFlag,
      rollout: [
        { variant: 'on', weight: 1 },
        { variant: 'off', weight: 3 },
      ],
    };

    const keys = users(20_000);
    const onShare =
      keys.filter((key) => evaluateFlag(flag, { targetingKey: key }).value === true).length /
      keys.length;

    expect(onShare).toBeGreaterThan(0.24);
    expect(onShare).toBeLessThan(0.26);
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

  it('keeps a dangling default variant diagnosed as the defect it is', () => {
    // Both things are wrong: no targeting key to bucket on, and a default
    // variant that does not exist. Reporting the bucketing complaint would
    // point the operator at the wrong one and leave `value: undefined`
    // unexplained.
    const result = evaluateFlag(
      { ...booleanFlag, defaultVariant: 'ghost', rollout: [{ variant: 'on', weight: 100 }] },
      {},
    );

    expect(result).toMatchObject({
      value: undefined,
      reason: 'ERROR',
      errorCode: 'VARIANT_NOT_FOUND',
    });
    expect(result.errorMessage).toContain('ghost');
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

  it('needs no targeting key to fall through a parked split', () => {
    // A split with no weight resolves to nothing whoever the subject is, so it
    // never reaches the hash. Pausing an experiment must not start erroring
    // every context that has no targeting key.
    const result = evaluateFlag({
      ...booleanFlag,
      rollout: [
        { variant: 'on', weight: 0 },
        { variant: 'off', weight: 0 },
      ],
    });

    expect(result).toMatchObject({ value: false, variant: 'off', reason: 'STATIC' });
    expect(result.errorCode).toBeUndefined();
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

  it('stops at the first matching rule even when its split is parked at zero', () => {
    // Pausing an experiment must not promote a lower-priority rule to
    // production. The matched rule decides, and a split with no weight decides
    // on the default variant.
    const result = evaluateFlag(
      {
        ...booleanFlag,
        rules: [
          {
            id: 'parked-experiment',
            conditions: [],
            rollout: [
              { variant: 'on', weight: 0 },
              { variant: 'off', weight: 0 },
            ],
          },
          { id: 'catch-all', conditions: [], variant: 'on' },
        ],
      },
      { targetingKey: 'user-1' },
    );

    expect(result).toMatchObject({
      value: false,
      variant: 'off',
      reason: 'STATIC',
      ruleId: 'parked-experiment',
    });
  });

  it('lets a rule rollout decide even when the rule also names a variant', () => {
    // The rollout wins whenever a rule declares one. Parking it at zero is how
    // an experiment is paused, and that must not ship the fixed variant to
    // everyone the rule matches.
    const rule = {
      id: 'experiment',
      conditions: [],
      variant: 'on',
      rollout: [
        { variant: 'on', weight: 0 },
        { variant: 'off', weight: 0 },
      ],
    };

    expect(
      evaluateFlag({ ...booleanFlag, rules: [rule] }, { targetingKey: 'user-1' }),
    ).toMatchObject({ value: false, variant: 'off', reason: 'STATIC', ruleId: 'experiment' });

    // Unparked, the rollout still decides — the fixed variant never applies.
    const running = { ...rule, rollout: [{ variant: 'off', weight: 100 }] };
    expect(
      evaluateFlag({ ...booleanFlag, rules: [running] }, { targetingKey: 'user-1' }),
    ).toMatchObject({ value: false, variant: 'off', reason: 'SPLIT', ruleId: 'experiment' });
  });
});

describe('a split buckets only on an identity the context owns', () => {
  it('buckets on the targeting key only when the context owns it', () => {
    // An inherited key must not decide a split: the identity that drives
    // bucketing goes through the same own-property read as every condition.
    const flag: FlagDefinition<boolean> = {
      ...booleanFlag,
      rollout: [{ variant: 'on', weight: 100 }],
    };

    const inherited = Object.create({ targetingKey: 'user-1' }) as { targetingKey?: string };
    const result = evaluateFlag(flag, inherited);

    expect(result.errorCode).toBe('TARGETING_KEY_MISSING');
    expect(evaluateFlag(flag, { targetingKey: 'user-1' }).variant).toBe('on');
  });

  it('buckets on an inherited bucketBy attribute no more than on an inherited key', () => {
    const flag: FlagDefinition<boolean> = {
      ...booleanFlag,
      rollout: { bucketBy: 'accountId', buckets: [{ variant: 'on', weight: 100 }] },
    };

    const inherited = Object.create({ accountId: 'acct-1' }) as { accountId?: string };

    expect(evaluateFlag(flag, inherited).errorCode).toBe('TARGETING_KEY_MISSING');
    expect(evaluateFlag(flag, { accountId: 'acct-1' }).variant).toBe('on');
  });
});
