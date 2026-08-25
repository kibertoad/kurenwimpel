/**
 * What a split does with the weights it is handed: a bucket parked at zero,
 * and one carrying a weight that is not a number at all. Split resolution
 * itself lives in `rollout.test.ts`, which is at its size budget.
 */

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

describe('a split never serves weight nobody asked for', () => {
  it('leaves a zero-weight bucket unserved for every subject', () => {
    // The float-drift fallback used to return the last bucket outright, which
    // can be one an operator parked at zero precisely so it would never ship.
    const flag: FlagDefinition<boolean> = {
      ...booleanFlag,
      rollout: [
        { variant: 'on', weight: 100 },
        { variant: 'off', weight: 0 },
      ],
    };

    const served = new Set(
      users(5_000).map((key) => evaluateFlag(flag, { targetingKey: key }).variant),
    );

    expect(served).toEqual(new Set(['on']));
  });

  it('keeps a bucket with a non-numeric weight out of the split entirely', () => {
    // A NaN weight reaches evaluation only hand-built — the parser rejects
    // every non-finite one. It used to clear the loop's `weight <= 0` filter
    // while failing the total's `weight > 0` one, so `cumulative` went NaN from
    // that bucket onward and every later comparison answered false: the buckets
    // after it were never served and the last one absorbed their whole share.
    const flag = {
      key: 'ab-test',
      enabled: true,
      variants: { a: 'a', b: 'b', c: 'c', d: 'd' },
      defaultVariant: 'a',
      offVariant: 'a',
      rollout: [
        { variant: 'a', weight: 10 },
        { variant: 'b', weight: Number.NaN },
        { variant: 'c', weight: 10 },
        { variant: 'd', weight: 80 },
      ],
    } as unknown as FlagDefinition;

    const keys = users(20_000);
    const share = (variant: string): number =>
      keys.filter((key) => evaluateFlag(flag, { targetingKey: key }).variant === variant).length /
      keys.length;

    expect(share('b')).toBe(0);
    expect(share('a')).toBeGreaterThan(0.09);
    expect(share('c')).toBeGreaterThan(0.09);
    expect(share('d')).toBeGreaterThan(0.78);
    expect(share('d')).toBeLessThan(0.82);
  });
});
