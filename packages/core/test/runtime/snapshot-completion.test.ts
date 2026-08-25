/**
 * `completeSnapshot` on partially-complete snapshots, and the meta a snapshot
 * keeps. `snapshot.test.ts` proves the all-or-nothing cases; a third-party
 * provider can just as well build a snapshot missing exactly one lookup.
 */

import { describe, expect, it } from 'vitest';

import { completeSnapshot, createSnapshot } from '../../src/index.js';
import type { FlagDefinition, FlagSnapshot } from '../../src/index.js';

const flag: FlagDefinition = {
  key: 'checkout',
  enabled: true,
  variants: { on: true, off: false },
  defaultVariant: 'off',
  offVariant: 'off',
  targets: [{ variant: 'on', keys: ['qa'] }],
};

describe('completeSnapshot fills exactly what is missing', () => {
  const flags = new Map([[flag.key, flag]]);

  it('defaults absent segments to empty without touching the rest', () => {
    const partial = { flags, targetIndex: new Map(), version: 'v1', fetchedAt: 1 };
    const completed = completeSnapshot(partial as unknown as FlagSnapshot);

    expect(completed.segments.size).toBe(0);
    expect(completed.flags).toBe(flags);
    expect(completed.version).toBe('v1');
  });

  it('rebuilds an absent target index from the flags it was given', () => {
    const partial = { flags, segments: new Map(), version: undefined, fetchedAt: 1 };
    const completed = completeSnapshot(partial as unknown as FlagSnapshot);

    expect(completed.targetIndex.get('checkout')?.get('qa')).toBe('on');
  });
});

describe('the meta a snapshot keeps', () => {
  it('keeps the fetchedAt it was handed, zero included', () => {
    // `?? Date.now()` fills only a missing timestamp. Zero is the epoch, not
    // an absence — EMPTY_SNAPSHOT relies on exactly that spelling.
    expect(createSnapshot([flag], { fetchedAt: 123 }).fetchedAt).toBe(123);
    expect(createSnapshot([flag], { fetchedAt: 0 }).fetchedAt).toBe(0);
    expect(createSnapshot([flag]).fetchedAt).toBeGreaterThan(0);
  });
});
