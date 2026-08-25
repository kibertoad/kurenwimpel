import { describe, expect, it } from 'vitest';

import { isCompiledSegment } from '../../src/evaluation/segments.js';

/** A segment that reached evaluation without the parser or the compiler. */
const hand = (overrides: Record<string, unknown>): Segment =>
  ({ key: 'beta', ...overrides }) as unknown as Segment;
import { compileSegment, createSnapshot, isInSegment } from '../../src/index.js';
import type { Segment, SegmentDefinition, SegmentRule } from '../../src/index.js';

describe('compileSegment', () => {
  it('compiles key lists to sets and defaults the rest', () => {
    const compiled = compileSegment({ key: 'beta', included: ['u1'] });

    expect(compiled.included.has('u1')).toBe(true);
    expect(compiled.excluded.size).toBe(0);
    expect(compiled.rules).toEqual([]);
  });

  it('completes a half-compiled segment instead of trusting its type', () => {
    // A snapshot may be hand-built, so `included` can already be a Set while
    // the other two fields were never filled in. Evaluation must not meet a
    // segment with a missing set or rule list.
    const half = { key: 'beta', included: new Set(['u1']) } as unknown as SegmentDefinition;
    const compiled = compileSegment(half);

    expect(compiled.included.has('u1')).toBe(true);
    expect(compiled.excluded).toBeInstanceOf(Set);
    expect(compiled.rules).toEqual([]);
  });

  it('copies the rule list rather than aliasing the definition', () => {
    // A snapshot promises an immutable, point-in-time view. Held by reference,
    // a later push into the caller's array changed who a live snapshot matched.
    const rules: SegmentRule[] = [
      { id: 'pro', conditions: [{ attribute: 'plan', operator: 'eq', value: 'pro' }] },
    ];
    const snapshot = createSnapshot([], {}, [{ key: 'beta', rules }]);

    rules.push({ id: 'free', conditions: [{ attribute: 'plan', operator: 'eq', value: 'free' }] });

    const stored = snapshot.segments.get('beta')!;
    expect(stored.rules).toHaveLength(1);
    expect(isInSegment(stored, { plan: 'free' })).toBe(false);
  });

  it('copies a key list that arrives as a Set', () => {
    const included = new Set(['u1']);
    const compiled = compileSegment({ key: 'beta', included } as unknown as SegmentDefinition);

    included.add('u2');

    expect(compiled.included.has('u1')).toBe(true);
    expect(compiled.included.has('u2')).toBe(false);
  });

  it('reads any iterable key list, including a Set from another realm', () => {
    // A cross-realm Set fails `instanceof` while being exactly what it claims,
    // and used to compile to nothing at all — every key silently dropped.
    const foreign = { [Symbol.iterator]: (): Iterator<string> => ['u1'][Symbol.iterator]() };
    const compiled = compileSegment({
      key: 'beta',
      included: foreign,
    } as unknown as SegmentDefinition);

    expect(compiled.included.has('u1')).toBe(true);
  });

  it('fails closed on a key list that is not a list', () => {
    // A bare string would otherwise compile to its characters.
    const compiled = compileSegment({
      key: 'beta',
      included: 'u1',
    } as unknown as SegmentDefinition);

    expect(compiled.included.size).toBe(0);
    expect(compiled.included.has('u')).toBe(false);
  });
});

describe('isCompiledSegment', () => {
  it('accepts a fully compiled segment and rejects a half-compiled one', () => {
    expect(isCompiledSegment(compileSegment({ key: 'beta', included: ['u1'] }))).toBe(true);
    expect(isCompiledSegment({ key: 'beta', included: ['u1'] })).toBe(false);

    // The trap: `included` alone is not evidence the rest was compiled.
    const half = { key: 'beta', included: new Set(['u1']) } as unknown as SegmentDefinition;
    expect(isCompiledSegment(half)).toBe(false);
  });
});

describe('createSnapshot with hand-built segments', () => {
  it('stores a usable segment for a half-compiled input', () => {
    const half = { key: 'beta', included: new Set(['u1']) } as unknown as SegmentDefinition;
    const snapshot = createSnapshot([], {}, [half]);
    const stored = snapshot.segments.get('beta');

    expect(stored).toBeDefined();
    expect(isInSegment(stored!, { targetingKey: 'u1' })).toBe(true);
    expect(isInSegment(stored!, { targetingKey: 'u2' })).toBe(false);
  });
});

describe('isInSegment on segments the compiler never saw', () => {
  it('skips a rule whose conditions are not a list', () => {
    // The same rule flag targeting follows: an empty condition list means
    // "everyone", so a rule carrying no list at all must not be read as one.
    const segment = hand({
      included: new Set(),
      excluded: new Set(),
      rules: [{ id: 'r1', conditions: undefined }],
    });

    expect(isInSegment(segment, { targetingKey: 'u1', plan: 'pro' })).toBe(false);
  });

  it('fails closed rather than throwing on missing sets or rules', () => {
    expect(isInSegment(hand({ included: new Set(['u1']) }), { targetingKey: 'u1' })).toBe(true);
    expect(isInSegment(hand({ included: new Set(['u1']) }), { targetingKey: 'u2' })).toBe(false);
    expect(isInSegment(hand({}), { targetingKey: 'u1' })).toBe(false);
  });
});

describe('a segment the compiler never saw is compiled once, not once per test', () => {
  it('goes on matching against the form taken at the first membership test', () => {
    // Compiling per test rebuilt both key sets and copied the rule list on
    // every evaluation — the exact per-request cost this module exists to
    // remove, paid a million insertions at a time by a million-key segment.
    // The staleness that buys is the one a snapshot's segments have by
    // construction, and the trade `foldedTargets` already makes.
    const definition: SegmentDefinition & { included: string[] } = {
      key: 'beta',
      included: ['u1'],
    };

    expect(isInSegment(definition, { targetingKey: 'u1' })).toBe(true);

    definition.included.push('u2');

    expect(isInSegment(definition, { targetingKey: 'u2' })).toBe(false);
    expect(isInSegment(definition, { targetingKey: 'u1' })).toBe(true);
  });

  it('leaves an already-compiled segment untouched', () => {
    const compiled = compileSegment({ key: 'beta', included: ['u1'] });
    expect(isInSegment(compiled, { targetingKey: 'u1' })).toBe(true);
  });
});
