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
      (key) => bucketOf('checkout', key) < BUCKET_COUNT / 2,
    ).length;

    expect(lowAssignment / admitted.length).toBeGreaterThan(0.47);
    expect(lowAssignment / admitted.length).toBeLessThan(0.53);
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
