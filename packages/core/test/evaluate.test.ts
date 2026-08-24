import { describe, expect, it } from 'vitest';

import { BUCKET_COUNT, bucketOf, evaluateFlag, murmurHash3 } from '../src/index.js';
import type { AttributeValue, Condition, FlagDefinition } from '../src/index.js';

const booleanFlag: FlagDefinition<boolean> = {
  key: 'new-checkout',
  enabled: true,
  variants: { on: true, off: false },
  defaultVariant: 'off',
  offVariant: 'off',
};

describe('murmurHash3', () => {
  it('matches the reference vectors for MurmurHash3 x86 32-bit', () => {
    expect(murmurHash3('')).toBe(0);
    expect(murmurHash3('', 1)).toBe(0x514e_28b7);
    expect(murmurHash3('', 0xffff_ffff)).toBe(0x81f1_6f39);
    expect(murmurHash3('test', 0)).toBe(0xba6b_d213);
    expect(murmurHash3('Hello, world!', 0)).toBe(0xc0363e43);
  });

  it('hashes multi-byte characters by their UTF-8 bytes', () => {
    // Would collide with the ASCII form if we hashed UTF-16 code units.
    expect(murmurHash3('é')).not.toBe(murmurHash3('e'));
  });
});

describe('bucketOf', () => {
  it('is stable across calls', () => {
    expect(bucketOf('flag', 'user-1')).toBe(bucketOf('flag', 'user-1'));
  });

  it('stays inside the bucket range', () => {
    for (let index = 0; index < 500; index++) {
      const bucket = bucketOf('flag', `user-${index}`);
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(BUCKET_COUNT);
    }
  });

  it('decorrelates subjects across flags', () => {
    const sameBucket = Array.from({ length: 200 }, (_, index) => `user-${index}`).filter(
      (key) => bucketOf('flag-a', key) === bucketOf('flag-b', key),
    );
    // Independent hashes should almost never agree over 200 subjects.
    expect(sameBucket.length).toBeLessThan(5);
  });

  it('distributes roughly uniformly', () => {
    const total = 10_000;
    let lowerHalf = 0;

    for (let index = 0; index < total; index++) {
      if (bucketOf('spread', `subject-${index}`) < BUCKET_COUNT / 2) lowerHalf += 1;
    }

    expect(lowerHalf / total).toBeGreaterThan(0.47);
    expect(lowerHalf / total).toBeLessThan(0.53);
  });
});

describe('evaluateFlag', () => {
  it('serves the off variant when disabled, ignoring rules', () => {
    const result = evaluateFlag(
      {
        ...booleanFlag,
        enabled: false,
        rules: [{ id: 'always', conditions: [], variant: 'on' }],
      },
      { targetingKey: 'user-1' },
    );

    expect(result).toMatchObject({ value: false, variant: 'off', reason: 'DISABLED' });
  });

  it('serves the default variant when nothing matches', () => {
    const result = evaluateFlag(booleanFlag, { targetingKey: 'user-1' });
    expect(result).toMatchObject({ value: false, variant: 'off', reason: 'DEFAULT' });
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
        ],
      },
      { targetingKey: 'user-1', attributes: { email: 'dev@lokalise.com' } },
    );

    expect(result).toMatchObject({
      value: true,
      variant: 'on',
      reason: 'TARGETING_MATCH',
      ruleId: 'internal-staff',
    });
  });

  it('stops at the first matching rule', () => {
    const result = evaluateFlag(
      {
        ...booleanFlag,
        variants: { on: true, off: false },
        rules: [
          { id: 'first', conditions: [], variant: 'on' },
          { id: 'second', conditions: [], variant: 'off' },
        ],
      },
      { targetingKey: 'user-1' },
    );

    expect(result.ruleId).toBe('first');
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

    expect(evaluateFlag(flag, { attributes: { plan: 'pro', region: 'eu' } }).value).toBe(true);
    expect(evaluateFlag(flag, { attributes: { plan: 'pro', region: 'us' } }).value).toBe(false);
  });

  it('splits a rollout deterministically and close to the declared weights', () => {
    const flag: FlagDefinition<boolean> = {
      ...booleanFlag,
      rollout: [
        { variant: 'on', weight: 25 },
        { variant: 'off', weight: 75 },
      ],
    };

    const keys = Array.from({ length: 20_000 }, (_, index) => `user-${index}`);
    const onCount = keys.filter(
      (key) => evaluateFlag(flag, { targetingKey: key }).value === true,
    ).length;

    expect(onCount / keys.length).toBeGreaterThan(0.24);
    expect(onCount / keys.length).toBeLessThan(0.26);

    // Same subject, same answer.
    const first = evaluateFlag(flag, { targetingKey: 'user-42' });
    expect(evaluateFlag(flag, { targetingKey: 'user-42' })).toEqual(first);
    expect(first.reason).toBe('SPLIT');
  });

  it('normalises relative rollout weights', () => {
    const flag: FlagDefinition<boolean> = {
      ...booleanFlag,
      rollout: [
        { variant: 'on', weight: 1 },
        { variant: 'off', weight: 3 },
      ],
    };

    const keys = Array.from({ length: 10_000 }, (_, index) => `u${index}`);
    const onCount = keys.filter(
      (key) => evaluateFlag(flag, { targetingKey: key }).value === true,
    ).length;

    expect(onCount / keys.length).toBeGreaterThan(0.23);
    expect(onCount / keys.length).toBeLessThan(0.27);
  });

  it('keeps a subject in the retained slice when a rollout is widened', () => {
    const at20: FlagDefinition<boolean> = {
      ...booleanFlag,
      rollout: [
        { variant: 'on', weight: 20 },
        { variant: 'off', weight: 80 },
      ],
    };
    const at50: FlagDefinition<boolean> = {
      ...booleanFlag,
      rollout: [
        { variant: 'on', weight: 50 },
        { variant: 'off', weight: 50 },
      ],
    };

    const keys = Array.from({ length: 2000 }, (_, index) => `user-${index}`);
    const flipped = keys.filter(
      (key) =>
        evaluateFlag(at20, { targetingKey: key }).value === true &&
        evaluateFlag(at50, { targetingKey: key }).value === false,
    );

    // Ramping up must never take a subject out of the treatment group.
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

  it('errors instead of throwing when a variant is missing', () => {
    const result = evaluateFlag(
      {
        ...booleanFlag,
        defaultVariant: 'off',
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

  it('reads the reserved targetingKey attribute', () => {
    const result = evaluateFlag(
      {
        ...booleanFlag,
        rules: [
          {
            id: 'allowlist',
            conditions: [{ attribute: 'targetingKey', operator: 'in', value: ['user-7'] }],
            variant: 'on',
          },
        ],
      },
      { targetingKey: 'user-7' },
    );

    expect(result.value).toBe(true);
  });

  it('matches array attributes as sets', () => {
    const flag: FlagDefinition<boolean> = {
      ...booleanFlag,
      rules: [
        {
          id: 'admins',
          conditions: [{ attribute: 'roles', operator: 'in', value: ['admin'] }],
          variant: 'on',
        },
      ],
    };

    expect(evaluateFlag(flag, { attributes: { roles: ['billing', 'admin'] } }).value).toBe(true);
    expect(evaluateFlag(flag, { attributes: { roles: ['billing'] } }).value).toBe(false);
  });

  it('supports non-boolean variant payloads', () => {
    const config: FlagDefinition = {
      key: 'rate-limit',
      enabled: true,
      variants: {
        strict: { perMinute: 60, burst: 10 },
        relaxed: { perMinute: 600, burst: 100 },
      },
      defaultVariant: 'strict',
      offVariant: 'strict',
      rules: [
        {
          id: 'enterprise',
          conditions: [{ attribute: 'plan', operator: 'eq', value: 'enterprise' }],
          variant: 'relaxed',
        },
      ],
    };

    expect(evaluateFlag(config, { attributes: { plan: 'enterprise' } }).value).toEqual({
      perMinute: 600,
      burst: 100,
    });
  });

  describe('operators', () => {
    const check = (condition: Condition, attributes: Record<string, AttributeValue>): boolean =>
      evaluateFlag(
        { ...booleanFlag, rules: [{ id: 'r', conditions: [condition], variant: 'on' }] },
        { attributes },
      ).value === true;

    it('compares numbers', () => {
      expect(check({ attribute: 'seats', operator: 'gt', value: 10 }, { seats: 11 })).toBe(true);
      expect(check({ attribute: 'seats', operator: 'gt', value: 10 }, { seats: 10 })).toBe(false);
      expect(check({ attribute: 'seats', operator: 'gte', value: 10 }, { seats: 10 })).toBe(true);
      expect(check({ attribute: 'seats', operator: 'lt', value: 10 }, { seats: 9 })).toBe(true);
      expect(check({ attribute: 'seats', operator: 'lte', value: 10 }, { seats: 10 })).toBe(true);
    });

    it('does not coerce strings into number comparisons', () => {
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
      expect(
        check({ attribute: 'plan', operator: 'notIn', value: ['free'] }, { plan: 'pro' }),
      ).toBe(true);
    });

    it('handles string operators', () => {
      expect(
        check(
          { attribute: 'host', operator: 'contains', value: 'staging' },
          { host: 'a-staging-1' },
        ),
      ).toBe(true);
      expect(
        check({ attribute: 'host', operator: 'startsWith', value: 'eu-' }, { host: 'eu-west-1' }),
      ).toBe(true);
    });
  });
});
