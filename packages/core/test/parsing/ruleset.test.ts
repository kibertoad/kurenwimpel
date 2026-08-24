import { describe, expect, it } from 'vitest';

import {
  FlagParseError,
  parseFlagDefinitions,
  parseRuleset,
  parseSegmentDefinition,
} from '../../src/index.js';

const validFlag = {
  key: 'new-checkout',
  enabled: true,
  variants: { on: true, off: false },
  defaultVariant: 'off',
  offVariant: 'off',
};

const validSegment = {
  key: 'beta-testers',
  included: ['user-1'],
  rules: [
    {
      id: 'internal',
      conditions: [{ attribute: 'email', operator: 'endsWith', value: '@example.com' }],
    },
  ],
};

describe('parseSegmentDefinition', () => {
  it('accepts lists and rules', () => {
    expect(parseSegmentDefinition(validSegment)).toEqual(validSegment);
  });

  it('accepts a pure key-list segment', () => {
    const parsed = parseSegmentDefinition({ key: 's', included: ['a'], excluded: ['b'] });
    expect(parsed).toEqual({ key: 's', included: ['a'], excluded: ['b'] });
  });

  it.each([
    ['a non-object', 7],
    ['a missing key', { included: ['a'] }],
    ['an empty segment', { key: 's' }],
    ['a non-string key list', { key: 's', included: [1] }],
    ['a rule without conditions', { key: 's', rules: [{ id: 'r', conditions: [] }] }],
  ])('rejects %s', (_label, input) => {
    expect(() => parseSegmentDefinition(input)).toThrow(FlagParseError);
  });

  it('rejects segment operators inside segment rules — membership does not nest', () => {
    expect(() =>
      parseSegmentDefinition({
        key: 's',
        rules: [{ id: 'r', conditions: [{ operator: 'inSegment', segments: ['other'] }] }],
      }),
    ).toThrow(/does not nest/u);
  });
});

describe('parseFlagDefinitions', () => {
  it('reads an array and a key-to-definition object', () => {
    expect(parseFlagDefinitions([validFlag]).flags).toHaveLength(1);
    expect(parseFlagDefinitions({ 'new-checkout': validFlag }).flags[0]?.key).toBe('new-checkout');
  });

  it('keeps the good flags and isolates the bad ones', () => {
    const { flags, issues } = parseFlagDefinitions([
      validFlag,
      { key: 'broken', enabled: 'nope' },
      { ...validFlag, key: 'other' },
    ]);

    expect(flags.map((flag) => flag.key)).toEqual(['new-checkout', 'other']);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.at).toBe('broken');
  });

  it('reports a root-level shape error', () => {
    const { flags, issues } = parseFlagDefinitions('not flags');
    expect(flags).toEqual([]);
    expect(issues[0]?.at).toBe('flags');
  });
});

describe('parseRuleset', () => {
  it('reads a bare array as flags only', () => {
    const result = parseRuleset([validFlag]);
    expect(result.flags).toHaveLength(1);
    expect(result.segments).toEqual([]);
    expect(result.issues).toEqual([]);
  });

  it('reads a legacy key-to-definition object as flags only', () => {
    const result = parseRuleset({ 'new-checkout': validFlag });
    expect(result.flags[0]?.key).toBe('new-checkout');
    expect(result.segments).toEqual([]);
  });

  it('reads the document form with flags and segments', () => {
    const result = parseRuleset({ flags: [validFlag], segments: [validSegment] });
    expect(result.flags).toHaveLength(1);
    expect(result.segments).toHaveLength(1);
    expect(result.issues).toEqual([]);
  });

  it('accepts a document with only one side present', () => {
    expect(parseRuleset({ segments: [validSegment] }).segments).toHaveLength(1);
    expect(parseRuleset({ flags: [validFlag] }).flags).toHaveLength(1);
  });

  it('collects issues from both sides without dropping the good definitions', () => {
    const result = parseRuleset({
      flags: [validFlag, { key: 'broken' }],
      segments: [validSegment, { key: 'empty' }],
    });

    expect(result.flags).toHaveLength(1);
    expect(result.segments).toHaveLength(1);
    expect(result.issues.map((issue) => issue.at)).toEqual(['broken', 'empty']);
  });
});
