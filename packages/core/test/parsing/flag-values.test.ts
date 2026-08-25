/**
 * The values a definition carries, as opposed to the fields it declares: a
 * variant payload that has to survive the OFREP wire whole, and the targeting
 * keys a flag pins to a variant.
 */

import { describe, expect, it } from 'vitest';

import { FlagParseError, parseFlagDefinition } from '../../src/index.js';

const valid = {
  key: 'new-checkout',
  enabled: true,
  variants: { on: true, off: false },
  defaultVariant: 'off',
  offVariant: 'off',
};

/** The valid flag, with one more variant carrying whatever is being tested. */
const withVariant = (value: unknown): unknown => ({
  ...valid,
  variants: { ...valid.variants, cfg: value },
});

describe('variant values have to be expressible all the way down', () => {
  it('rejects a non-finite number nested inside an object variant', () => {
    // The same rule metadata gets, and for the reason its comment gives:
    // JSON.stringify turns these into null on the OFREP wire, so the flag is
    // unserveable in a way only the protocol layer would have discovered.
    expect(() => parseFlagDefinition(withVariant({ perMinute: Number.POSITIVE_INFINITY }))).toThrow(
      /perMinute/u,
    );
    expect(() => parseFlagDefinition(withVariant({ nested: { n: Number.NaN } }))).toThrow(
      /nested\.n/u,
    );
    expect(() => parseFlagDefinition(withVariant({ limits: [1, Number.NaN] }))).toThrow(
      /limits\[1\]/u,
    );
  });

  it('rejects nested values JSON.stringify drops outright', () => {
    // Worse than a null: the served object is missing the field entirely.
    expect(() => parseFlagDefinition(withVariant({ a: undefined }))).toThrow(FlagParseError);
    expect(() => parseFlagDefinition(withVariant({ a: () => 1 }))).toThrow(FlagParseError);
    expect(() => parseFlagDefinition(withVariant({ a: Symbol('s') }))).toThrow(FlagParseError);
    expect(() => parseFlagDefinition(withVariant({ a: BigInt(1) }))).toThrow(FlagParseError);
  });

  it('still accepts every nested shape JSON can carry', () => {
    const parsed = parseFlagDefinition(withVariant({ hosts: ['a', 'b'], limit: 3, off: null }));
    expect(parsed.variants['cfg']).toEqual({ hosts: ['a', 'b'], limit: 3, off: null });
  });

  it('reports a cycle as a parse failure rather than overflowing the stack', () => {
    // A compiled-in definition can hold one, and a caller that catches
    // FlagParseError would miss a RangeError thrown from underneath it.
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic['self'] = cyclic;

    expect(() => parseFlagDefinition(withVariant(cyclic))).toThrow(FlagParseError);
  });

  it('reports a value nested past the bound the same way', () => {
    let deep: Record<string, unknown> = { leaf: true };
    for (let level = 0; level < 500; level += 1) deep = { next: deep };

    expect(() => parseFlagDefinition(withVariant(deep))).toThrow(FlagParseError);
  });
});

describe('a targeting key claimed twice', () => {
  it('names the target that repeats a key inside its own list', () => {
    // Reported as a clash between two targets, this sent whoever read it
    // looking for a second target that does not exist.
    expect(() =>
      parseFlagDefinition({ ...valid, targets: [{ variant: 'on', keys: ['u1', 'u1'] }] }),
    ).toThrow(/target on lists targeting key "u1" more than once/u);
  });

  it('still reports a key two targets both claim as the clash it is', () => {
    expect(() =>
      parseFlagDefinition({
        ...valid,
        targets: [
          { variant: 'on', keys: ['u1'] },
          { variant: 'off', keys: ['u1'] },
        ],
      }),
    ).toThrow(/targeting key "u1" appears in more than one target/u);
  });
});
