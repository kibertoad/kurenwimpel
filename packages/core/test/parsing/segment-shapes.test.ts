/**
 * `parseSegmentDefinition` at its shape edges: which absences read as absent,
 * which read as malformed, and what the parsed segment carries.
 * `segment.test.ts` proves the shapes a control plane ships and the dropped-
 * rule tolerance; this is the boundary layer under it.
 */

import { describe, expect, it } from 'vitest';

import { FlagParseError, parseSegmentDefinition } from '../../src/index.js';

describe('parseSegmentDefinition shape edges', () => {
  it('rejects a segment that is not an object', () => {
    expect(() => parseSegmentDefinition(null)).toThrow(FlagParseError);
    expect(() => parseSegmentDefinition('beta')).toThrow(/segment must be an object/u);
  });

  it('rejects a segment with no criteria at all, naming the real absence', () => {
    // An audience that can never match anybody is worth an issue whichever way
    // it got there — and this way there were no rules to drop, so the message
    // must not claim there were.
    expect(() => parseSegmentDefinition({ key: 'beta' })).toThrow(
      /needs a non-empty included, excluded, or rules list/u,
    );
    expect(() => parseSegmentDefinition({ key: 'beta', included: [], rules: [] })).toThrow(
      /needs a non-empty/u,
    );
  });

  it('reads a null key list as absent rather than malformed', () => {
    const parsed = parseSegmentDefinition({ key: 'beta', included: null, excluded: ['u2'] });

    expect(parsed.excluded).toEqual(['u2']);
    expect(parsed).not.toHaveProperty('included');
    expect(parsed).not.toHaveProperty('rules');
  });

  it('reads null rules as absent but rejects rules of the wrong shape', () => {
    expect(
      parseSegmentDefinition({ key: 'beta', included: ['u1'], rules: null }),
    ).not.toHaveProperty('rules');
    expect(() => parseSegmentDefinition({ key: 'beta', rules: 'everyone' })).toThrow(
      /rules must be an array/u,
    );
    expect(() => parseSegmentDefinition({ key: 'beta', rules: ['everyone'] })).toThrow(
      /rule 0 must be an object/u,
    );
  });

  it('rejects a rule with no conditions: an empty list would mean "everyone"', () => {
    expect(() =>
      parseSegmentDefinition({ key: 'beta', rules: [{ id: 'r', conditions: [] }] }),
    ).toThrow(/non-empty conditions array/u);
  });
});
