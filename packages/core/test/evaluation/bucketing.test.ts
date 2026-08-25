import { describe, expect, it } from 'vitest';

import { BUCKET_COUNT, bucketOf, isAllocated, murmurHash3 } from '../../src/index.js';

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
    expect(bucketOf(['rollout', 'flag'], 'user-1')).toBe(bucketOf(['rollout', 'flag'], 'user-1'));
  });

  it('assigns the buckets it has always assigned', () => {
    // Golden values. The whole point of the module is that a subject lands in
    // the same bucket on every runtime and in every version, so a change to the
    // domain encoding — however harmless it looks — must fail here rather than
    // silently reshuffle every live experiment.
    expect(bucketOf(['rollout', 'checkout'], 'user-1')).toBe(4236);
    expect(bucketOf(['rule', 'checkout', 'beta'], 'user-1')).toBe(7682);
    expect(bucketOf(['allocation', 'checkout', 'run-2'], 'user-1')).toBe(1829);
  });

  it('stays inside the bucket range', () => {
    for (let index = 0; index < 500; index++) {
      const bucket = bucketOf(['rollout', 'flag'], `user-${index}`);
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(BUCKET_COUNT);
    }
  });

  it('decorrelates subjects across flags', () => {
    const sameBucket = Array.from({ length: 200 }, (_, index) => `user-${index}`).filter(
      (key) => bucketOf(['rollout', 'flag-a'], key) === bucketOf(['rollout', 'flag-b'], key),
    );
    // Independent hashes should almost never agree over 200 subjects.
    expect(sameBucket.length).toBeLessThan(5);
  });

  it('distributes roughly uniformly', () => {
    const total = 10_000;
    let lowerHalf = 0;

    for (let index = 0; index < total; index++) {
      if (bucketOf(['rollout', 'spread'], `subject-${index}`) < BUCKET_COUNT / 2) lowerHalf += 1;
    }

    expect(lowerHalf / total).toBeGreaterThan(0.47);
    expect(lowerHalf / total).toBeLessThan(0.53);
  });

  it('keeps domains injective when parts contain the delimiter', () => {
    // Without length-prefixing, ['rule', 'f', 'r1'] and ['rule', 'f:r1']
    // style tuples could encode to the same hash input.
    const sameBucket = Array.from({ length: 200 }, (_, index) => `user-${index}`).filter(
      (key) => bucketOf(['rule', 'f', 'r1'], key) === bucketOf(['rule', 'f:r1'], key),
    );
    expect(sameBucket.length).toBeLessThan(5);
  });
});

describe('isAllocated', () => {
  const keys = Array.from({ length: 10_000 }, (_, index) => `user-${index}`);

  it('short-circuits the boundary percentages', () => {
    expect(isAllocated({ percent: 100 }, 'salt', 'anyone')).toBe(true);
    expect(isAllocated({ percent: 0 }, 'salt', 'anyone')).toBe(false);
  });

  it('admits close to the requested share of traffic', () => {
    const admitted = keys.filter((key) => isAllocated({ percent: 20 }, 'checkout', key)).length;
    expect(admitted / keys.length).toBeGreaterThan(0.18);
    expect(admitted / keys.length).toBeLessThan(0.22);
  });

  it('only ever adds subjects when the allocation is widened', () => {
    const ejected = keys.filter(
      (key) =>
        isAllocated({ percent: 20 }, 'checkout', key) &&
        !isAllocated({ percent: 50 }, 'checkout', key),
    );
    expect(ejected).toHaveLength(0);
  });

  it('is decorrelated from variant-assignment buckets', () => {
    // The allocation gate and the treatment split hash different domains: the
    // admitted population must not be biased toward low assignment buckets.
    const admitted = keys.filter((key) => isAllocated({ percent: 50 }, 'checkout', key));
    const lowAssignment = admitted.filter(
      (key) => bucketOf(['rollout', 'checkout'], key) < BUCKET_COUNT / 2,
    ).length;

    expect(lowAssignment / admitted.length).toBeGreaterThan(0.47);
    expect(lowAssignment / admitted.length).toBeLessThan(0.53);
  });

  it('stays decorrelated even from a rollout seeded literally "allocation"', () => {
    // The old delimiter scheme collapsed seed 'allocation' onto the gate's own
    // domain, correlating admission with assignment.
    const admitted = keys.filter((key) => isAllocated({ percent: 50 }, 'checkout', key));
    const lowAssignment = admitted.filter(
      (key) => bucketOf(['rollout', 'checkout', 'allocation'], key) < BUCKET_COUNT / 2,
    ).length;

    expect(lowAssignment / admitted.length).toBeGreaterThan(0.47);
    expect(lowAssignment / admitted.length).toBeLessThan(0.53);
  });

  it('admits exactly the basis points a fractional percent asks for', () => {
    // (0.07 / 100) * 10_000 is 7.000000000000001 in floats; without rounding
    // that admits an eighth bucket — a 14% relative overshoot on the slice.
    const seven = keys.filter((key) => isAllocated({ percent: 0.07 }, 'canary', key));
    const admittedBuckets = new Set(seven.map((key) => bucketOf(['allocation', 'canary'], key)));

    for (const bucket of admittedBuckets) expect(bucket).toBeLessThan(7);
  });

  it('re-draws the admitted population when the seed changes', () => {
    const first = new Set(keys.filter((key) => isAllocated({ percent: 30 }, 'checkout', key)));
    const reseeded = keys.filter((key) =>
      isAllocated({ percent: 30, seed: 'run-2' }, 'checkout', key),
    );

    const overlap = reseeded.filter((key) => first.has(key)).length;
    // Independent draws overlap at about percent² — far below either population.
    expect(overlap).toBeLessThan(first.size * 0.5);
    expect(overlap).toBeGreaterThan(0);
  });
});
