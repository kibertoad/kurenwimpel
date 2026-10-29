import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as sha256 from '../../src/evaluation/sha256.js';
import {
  compileSegment,
  createSnapshot,
  evaluateFlag,
  isInSegment,
  parseRuleset,
  sha256Hex,
} from '../../src/index.js';
import type {
  FlagDefinition,
  FlagSnapshot,
  HashedKeyList,
  SegmentDefinition,
} from '../../src/index.js';

vi.mock('../../src/evaluation/sha256.js', { spy: true });

const KEYS = Array.from({ length: 50 }, (_unused, index) => `user-${index}`);
const PROBES = [...KEYS, 'stranger', 'user-50', 'USER-1', ''];

function hashed(keys: readonly string[]) {
  return { algorithm: 'sha256' as const, values: keys.map((key) => sha256Hex(key)) };
}

function flag(overrides: Partial<FlagDefinition> = {}): FlagDefinition {
  return {
    key: 'beta',
    enabled: true,
    variants: { on: true, off: false, pinned: true },
    defaultVariant: 'off',
    offVariant: 'off',
    rules: [
      {
        id: 'members',
        conditions: [{ operator: 'inSegment', segments: ['testers'] }],
        variant: 'on',
      },
    ],
    ...overrides,
  };
}

function snapshotOf(document: unknown): FlagSnapshot {
  const { flags, segments, issues } = parseRuleset(document);
  expect(issues).toEqual([]);
  return createSnapshot(flags, {}, segments);
}

function servedFor(snapshot: FlagSnapshot, targetingKey: string) {
  const result = evaluateFlag(snapshot.flags.get('beta')!, { targetingKey, plan: 'pro' }, snapshot);
  return [result.variant, result.reason];
}

function expectSameAnswers(plain: FlagSnapshot, digests: FlagSnapshot): void {
  for (const key of PROBES) {
    expect(servedFor(digests, key), key).toEqual(servedFor(plain, key));
  }
}

const included = KEYS.slice(0, 30);
const excluded = KEYS.slice(20, 40);
const rules = [{ id: 'pro', conditions: [{ attribute: 'plan', operator: 'eq', value: 'pro' }] }];

describe('hashed and plain lists give identical results', () => {
  it('for segment included and excluded lists', () => {
    const plain: SegmentDefinition = { key: 'testers', included, excluded };
    const digests: SegmentDefinition = {
      key: 'testers',
      includedHashes: hashed(included),
      excludedHashes: hashed(excluded),
    };

    expectSameAnswers(
      snapshotOf({ flags: [flag()], segments: [plain] }),
      snapshotOf({ flags: [flag()], segments: [digests] }),
    );
  });

  it('when exclusion has to win over a matching rule', () => {
    const plain = { key: 'testers', excluded, rules };
    const digests = { key: 'testers', excludedHashes: hashed(excluded), rules };

    expectSameAnswers(
      snapshotOf({ flags: [flag()], segments: [plain] }),
      snapshotOf({ flags: [flag()], segments: [digests] }),
    );
  });

  it('when one form excludes what the other includes', () => {
    const plainExcluded = { key: 'testers', included, excludedHashes: hashed(excluded) };
    const hashedExcluded = { key: 'testers', includedHashes: hashed(included), excluded };
    const reference = snapshotOf({
      flags: [flag()],
      segments: [{ key: 'testers', included, excluded }],
    });

    expectSameAnswers(reference, snapshotOf({ flags: [flag()], segments: [plainExcluded] }));
    expectSameAnswers(reference, snapshotOf({ flags: [flag()], segments: [hashedExcluded] }));
  });

  it('for individual targets', () => {
    const segments = [{ key: 'testers', included }];
    const plain = flag({ targets: [{ variant: 'pinned', keys: KEYS.slice(10, 25) }] });
    const digests = flag({
      targets: [{ variant: 'pinned', keyHashes: hashed(KEYS.slice(10, 25)) }],
    });

    expectSameAnswers(
      snapshotOf({ flags: [plain], segments }),
      snapshotOf({ flags: [digests], segments }),
    );
  });

  it('for a flag evaluated outside any snapshot', () => {
    const digests = flag({
      rules: [],
      targets: [{ variant: 'pinned', keyHashes: hashed(['qa']) }],
    });

    expect(evaluateFlag(digests, { targetingKey: 'qa' }).variant).toBe('pinned');
    expect(evaluateFlag(digests, { targetingKey: 'qb' }).variant).toBe('off');
  });
});

describe('hashing cost', () => {
  const spy = vi.mocked(sha256.sha256Hex);
  let run = 0;

  beforeEach(() => {
    spy.mockClear();
    run++;
  });

  it('never hashes for flags without hashed lists', () => {
    const snapshot = snapshotOf({
      flags: [flag({ targets: [{ variant: 'pinned', keys: ['qa'] }] })],
      segments: [{ key: 'testers', included }],
    });
    spy.mockClear();

    servedFor(snapshot, `plain-${run}`);
    expect(spy).not.toHaveBeenCalled();
  });

  it('hashes once per evaluation however many hashed lists it probes', () => {
    const snapshot = snapshotOf({
      flags: [
        flag({
          targets: [{ variant: 'pinned', keyHashes: hashed(['qa']) }],
          rules: [
            { id: 'a', conditions: [{ operator: 'inSegment', segments: ['one'] }], variant: 'on' },
            {
              id: 'b',
              conditions: [{ operator: 'notInSegment', segments: ['two'] }],
              variant: 'on',
            },
          ],
        }),
      ],
      segments: [
        { key: 'one', includedHashes: hashed(['x']), excludedHashes: hashed(['y']) },
        { key: 'two', excludedHashes: hashed(['z']) },
      ],
    });
    spy.mockClear();

    servedFor(snapshot, `hashed-${run}`);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('compiling hashed lists', () => {
  it('leaves the digest sets out of a segment that declares none', () => {
    const compiled = compileSegment({ key: 's', included: ['a'] });
    expect('includedHashes' in compiled).toBe(false);
    expect('excludedHashes' in compiled).toBe(false);
  });

  it('compiles a list naming an unknown algorithm to nothing', () => {
    const list = {
      algorithm: 'md5',
      values: [sha256Hex('a')],
    } as unknown as HashedKeyList;
    const compiled = compileSegment({ key: 's', includedHashes: list });
    expect(compiled.includedHashes).toBeUndefined();
    expect(isInSegment(compiled, { targetingKey: 'a' })).toBe(false);
  });

  it('recompiles a segment whose digest list is still in wire form', () => {
    const half = {
      key: 's',
      included: new Set<string>(),
      excluded: new Set<string>(),
      rules: [],
      includedHashes: hashed(['a']),
    } as unknown as SegmentDefinition;
    expect(isInSegment(half, { targetingKey: 'a' })).toBe(true);
  });
});
