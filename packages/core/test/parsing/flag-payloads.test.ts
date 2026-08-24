/**
 * The shapes a real control plane emits, as opposed to the ones a schema
 * describes: nulls for unset optional fields, empty collections in either wire
 * form, and payloads the caller keeps a reference to after parsing.
 */

import { describe, expect, it } from 'vitest';

import { parseFlagDefinition } from '../../src/index.js';

const valid = {
  key: 'new-checkout',
  enabled: true,
  variants: { on: true, off: false },
  defaultVariant: 'off',
  offVariant: 'off',
};

describe('optional fields that a control plane may serialise as null', () => {
  const rollout = [{ variant: 'on', weight: 1 }];

  it('reads a rule variant of null as absent rather than losing the flag', () => {
    // A rollout-only rule has no variant to send; emitting null for it used to
    // reject the whole flag, and every lookup then answered FLAG_NOT_FOUND.
    const parsed = parseFlagDefinition({
      ...valid,
      rules: [{ id: 'ramp', conditions: [], variant: null, rollout }],
    });

    expect(parsed.rules?.[0]?.variant).toBeUndefined();
    expect(parsed.rules?.[0]?.rollout).toEqual(rollout);
  });

  it('still rejects a variant that is present and wrong', () => {
    expect(() =>
      parseFlagDefinition({ ...valid, rules: [{ id: 'r', conditions: [], variant: 'ghost' }] }),
    ).toThrow(/unknown variant ghost/u);
    expect(() =>
      parseFlagDefinition({ ...valid, rules: [{ id: 'r', conditions: [], variant: 7, rollout }] }),
    ).toThrow(/variant/u);
  });
});

describe('the two wire forms of an empty split agree', () => {
  it('reads either form as "no rollout"', () => {
    // These used to disagree: the bare array parsed clean, the split object
    // rejected the flag outright, for the same absence of buckets.
    expect(parseFlagDefinition({ ...valid, rollout: [] }).rollout).toBeUndefined();
    expect(parseFlagDefinition({ ...valid, rollout: { buckets: [] } }).rollout).toBeUndefined();
  });

  it('still rejects a split object with no buckets array at all', () => {
    expect(() => parseFlagDefinition({ ...valid, rollout: { bucketBy: 'accountId' } })).toThrow(
      /buckets array/u,
    );
  });

  it('names the real problem when a rule declares an empty rollout and no variant', () => {
    // "must declare a variant or a rollout" sent the operator looking for a
    // field that was already there.
    expect(() =>
      parseFlagDefinition({ ...valid, rules: [{ id: 'ramp', conditions: [], rollout: [] }] }),
    ).toThrow(/empty rollout/u);

    expect(() =>
      parseFlagDefinition({ ...valid, rules: [{ id: 'ramp', conditions: [] }] }),
    ).toThrow(/must declare a variant or a rollout/u);
  });
});

describe('a parsed definition does not alias the payload it came from', () => {
  it('copies variant values, nested objects included', () => {
    // A provider that keeps its decoded body, or a StaticProvider handed a live
    // config object, could otherwise change what a live snapshot serves.
    const raw = {
      ...valid,
      variants: { on: { limit: 1 }, off: false },
      metadata: { owner: 'web' },
    };
    const parsed = parseFlagDefinition(raw);

    raw.variants.on.limit = 999;
    raw.metadata.owner = 'someone-else';

    expect(parsed.variants['on']).toEqual({ limit: 1 });
    expect(parsed.metadata?.['owner']).toBe('web');
  });
});
