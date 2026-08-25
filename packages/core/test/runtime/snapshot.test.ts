import { describe, expect, it } from 'vitest';

import {
  completeSnapshot,
  createSnapshot,
  FeatureFlagClient,
  parseRuleset,
  StaticProvider,
} from '../../src/index.js';
import type { FlagDefinition, FlagSnapshot } from '../../src/index.js';

describe('createSnapshot resolves duplicates the way the parser does', () => {
  const first: FlagDefinition = {
    key: 'dup',
    enabled: true,
    variants: { on: true, off: false },
    defaultVariant: 'on',
    offVariant: 'off',
  };
  const second: FlagDefinition = { ...first, enabled: false };

  it('keeps the first of two flags sharing a key', () => {
    // The parser keeps the first and reports the rest; this used to keep the
    // last, so a provider merging a bootstrap with a fetched ruleset got the
    // opposite answer from each half of the same pipeline.
    expect(createSnapshot([first, second]).flags.get('dup')?.enabled).toBe(true);
    expect(createSnapshot([second, first]).flags.get('dup')?.enabled).toBe(false);
  });

  it('agrees with parseRuleset on the same input', () => {
    const parsed = parseRuleset([first, second]);

    expect(parsed.flags).toHaveLength(1);
    expect(createSnapshot([first, second]).flags.get('dup')?.enabled).toBe(
      parsed.flags[0]?.enabled,
    );
  });

  it('keeps the first of two segments sharing a key', () => {
    const snapshot = createSnapshot([], {}, [
      { key: 'beta', included: ['first'] },
      { key: 'beta', included: ['second'] },
    ]);

    expect(snapshot.segments.get('beta')?.included).toEqual(new Set(['first']));
  });
});

/** A flag whose targets reached the snapshot builder without the parser. */
const targeted = (targets: unknown): FlagDefinition =>
  ({
    key: 'f',
    enabled: true,
    variants: { on: true, off: false },
    defaultVariant: 'off',
    offVariant: 'off',
    targets,
  }) as unknown as FlagDefinition;

describe('createSnapshot survives a target it cannot read', () => {
  it('leaves a malformed target out of the index instead of throwing', () => {
    // buildTargetIndex runs over every flag of every refresh, so one
    // hand-built target used to cost the whole snapshot its ruleset — where
    // the same definition handed to evaluateFlag degrades to one flag
    // reporting INVALID_DEFINITION.
    for (const targets of [[null], ['u1'], [42], [{ variant: 'on' }], {}, 'nope']) {
      const snapshot = createSnapshot([targeted(targets)]);
      expect(snapshot.targetIndex.size).toBe(0);
    }
  });

  it('keeps the readable targets of a list that also holds a broken one', () => {
    const snapshot = createSnapshot([targeted([null, { variant: 'on', keys: ['u1'] }])]);
    expect(snapshot.targetIndex.get('f')?.get('u1')).toBe('on');
  });
});

describe('completeSnapshot', () => {
  const flag: FlagDefinition = {
    key: 'f',
    enabled: true,
    variants: { on: true, off: false },
    defaultVariant: 'off',
    offVariant: 'off',
    targets: [{ variant: 'on', keys: ['u1'] }],
  };

  /** The shape a provider written before segments joined the snapshot builds. */
  const legacy = (): FlagSnapshot =>
    ({
      flags: new Map([[flag.key, flag]]),
      version: undefined,
      fetchedAt: 0,
    }) as unknown as FlagSnapshot;

  it('fills in the lookups a hand-built snapshot never carried', () => {
    const completed = completeSnapshot(legacy());

    expect(completed.segments.size).toBe(0);
    expect(completed.targetIndex.get('f')?.get('u1')).toBe('on');
  });

  it('hands a complete snapshot straight back', () => {
    const snapshot = createSnapshot([flag]);
    expect(completeSnapshot(snapshot)).toBe(snapshot);
  });

  it('completes a snapshot that never carried flags either', () => {
    // The one field that used to be dereferenced on the way to rebuilding the
    // index, so the very shapes this exists to absorb threw a TypeError out of
    // the public setSnapshot instead of being completed. An empty ruleset
    // answers FLAG_NOT_FOUND, which is a bad snapshot's honest answer.
    const bare = { fetchedAt: 0 } as unknown as FlagSnapshot;
    const completed = completeSnapshot(bare);

    expect(completed.flags.size).toBe(0);
    expect(completed.segments.size).toBe(0);
    expect(completed.targetIndex.size).toBe(0);

    const client = new FeatureFlagClient({ provider: new StaticProvider() });
    client.setSnapshot(bare);

    expect(client.ready).toBe(true);
    expect(client.evaluate('f', {}).errorCode).toBe('FLAG_NOT_FOUND');
    expect(client.evaluateAll({})).toEqual([]);
  });

  it('rebuilds flags that cannot be iterated, not just ones that are missing', () => {
    // Probeable is not enough: evaluateAll walks the flags, and the index is
    // built from them.
    // Probeable, and nothing else — no `values` to iterate.
    const halfLookup = { flags: { get: () => null }, fetchedAt: 0 } as unknown as FlagSnapshot;

    expect(completeSnapshot(halfLookup).flags.size).toBe(0);
  });

  it('is applied to whatever setSnapshot is given', () => {
    // setSnapshot is public and takes what it is handed; the client must not
    // go on serving a snapshot whose lookups read back undefined.
    const client = new FeatureFlagClient({ provider: new StaticProvider() });
    client.setSnapshot(legacy());

    expect(client.snapshot.segments.size).toBe(0);
    expect(client.snapshot.targetIndex.get('f')?.get('u1')).toBe('on');
    expect(client.getBoolean('f', false, { targetingKey: 'u1' })).toBe(true);
  });
});
