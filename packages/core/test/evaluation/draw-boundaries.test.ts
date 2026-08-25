/**
 * Golden draws at the exact edges of the hash domains.
 *
 * The statistical tests in `bucketing.test.ts` and `rollout.test.ts` prove the
 * distributions; what they cannot prove is the placement of one subject at the
 * very threshold, or the exact domain a draw hashes. Both are product
 * guarantees (ADR 0002): moving a threshold by one bucket or re-tagging a
 * domain reshuffles live experiments, so each is pinned to the value it has
 * always had. The buckets behind these fixtures: 'user-1' lands at 6857 in the
 * unseeded allocation domain and 1829 in the 'run-2'-seeded one; 'user-2147'
 * and 'user-4446' land at exactly 5000 in the rollout and rule domains used
 * below; 'user-1' lands at 3844 in the 'exp-1'-seeded rollout domain.
 */

import { describe, expect, it } from 'vitest';

import { evaluateFlag } from '../../src/index.js';
import type { FlagDefinition, TrafficAllocation } from '../../src/index.js';

const booleanFlag: FlagDefinition<boolean> = {
  key: 'checkout',
  enabled: true,
  variants: { on: true, off: false },
  defaultVariant: 'off',
  offVariant: 'off',
};

describe('the allocation gate admits strictly below its threshold', () => {
  const gated = (allocation: TrafficAllocation): FlagDefinition<boolean> => ({
    ...booleanFlag,
    allocation,
    rollout: [{ variant: 'on', weight: 100 }],
  });

  it('admits the bucket one below the threshold and refuses the one at it', () => {
    // 'user-1' buckets at 6857: percent 68.58 admits buckets 0..6857, 68.57
    // admits 0..6856. The strictness is the fairness contract — percent 68.57
    // must admit exactly 6857 of 10 000 buckets, not 6858.
    expect(evaluateFlag(gated({ percent: 68.58 }), { targetingKey: 'user-1' }).reason).toBe(
      'SPLIT',
    );
    expect(evaluateFlag(gated({ percent: 68.57 }), { targetingKey: 'user-1' }).reason).toBe(
      'NOT_ALLOCATED',
    );
  });

  it('draws a seeded gate from its own domain, at the same strictness', () => {
    // Under seed 'run-2' the same subject buckets at 1829 — the reshuffle a
    // seed exists for. The threshold pair pins the seeded domain exactly.
    expect(
      evaluateFlag(gated({ percent: 18.3, seed: 'run-2' }), { targetingKey: 'user-1' }).reason,
    ).toBe('SPLIT');
    expect(
      evaluateFlag(gated({ percent: 18.29, seed: 'run-2' }), { targetingKey: 'user-1' }).reason,
    ).toBe('NOT_ALLOCATED');
  });
});

describe('a split assigns the boundary bucket to the next variant', () => {
  it('sends a subject at exactly the cumulative edge past the first bucket', () => {
    // 'user-2147' buckets at exactly 5000 of a [5000, 5000] split: the first
    // bucket owns [0, 5000), so the edge belongs to the second.
    const flag: FlagDefinition<boolean> = {
      ...booleanFlag,
      key: 'boundary',
      rollout: [
        { variant: 'on', weight: 5000 },
        { variant: 'off', weight: 5000 },
      ],
    };

    expect(evaluateFlag(flag, { targetingKey: 'user-2147' }).variant).toBe('off');
  });

  it('applies the same edge inside a rule-level split', () => {
    // 'user-4446' buckets at exactly 5000 in the ['rule', 'boundary', 'r1']
    // domain — the rule draw, not the flag draw, decides the edge.
    const flag: FlagDefinition<boolean> = {
      ...booleanFlag,
      key: 'boundary',
      rules: [
        {
          id: 'r1',
          conditions: [],
          rollout: [
            { variant: 'on', weight: 5000 },
            { variant: 'off', weight: 5000 },
          ],
        },
      ],
    };

    expect(evaluateFlag(flag, { targetingKey: 'user-4446' })).toMatchObject({
      variant: 'off',
      ruleId: 'r1',
    });
  });
});

describe('a seeded split draws from the seeded domain', () => {
  it('places the subject at the bucket the seed has always given it', () => {
    // Under seed 'exp-1', 'user-1' buckets at 3844: a first bucket weighted
    // 3845 holds it, one weighted 3844 does not. The pair pins the domain —
    // tag, salt, and seed — to within a single bucket.
    const seeded = (weight: number): FlagDefinition<boolean> => ({
      ...booleanFlag,
      rollout: {
        seed: 'exp-1',
        buckets: [
          { variant: 'on', weight },
          { variant: 'off', weight: 10_000 - weight },
        ],
      },
    });

    expect(evaluateFlag(seeded(3845), { targetingKey: 'user-1' }).variant).toBe('on');
    expect(evaluateFlag(seeded(3844), { targetingKey: 'user-1' }).variant).toBe('off');
  });
});
