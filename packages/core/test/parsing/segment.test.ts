/**
 * `parseSegmentDefinition` on its own. Segments inside a whole payload —
 * cross-references, duplicate keys, the document form — are in
 * `ruleset.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import { FlagParseError, parseSegmentDefinition } from '../../src/index.js';
import type { FlagParseIssue } from '../../src/index.js';

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
    // Presence is not content: two empty sets and no rules match nobody,
    // forever, so every inSegment naming it matches nobody and every
    // notInSegment matches everybody — with nothing to explain why.
    ['a segment whose only list is empty', { key: 's', included: [] }],
    ['a segment whose lists and rules are all empty', { key: 's', excluded: [], rules: [] }],
    ['a non-string key list', { key: 's', included: [1] }],
    ['a rule without conditions', { key: 's', rules: [{ id: 'r', conditions: [] }] }],
  ])('rejects %s', (_label, input) => {
    expect(() => parseSegmentDefinition(input)).toThrow(FlagParseError);
  });

  it('drops a segment rule using an unsupported operator and keeps the segment', () => {
    // An operator a newer control plane knows costs the rule, not the segment:
    // the rule could never have granted membership anyway.
    const warnings: FlagParseIssue[] = [];
    const rules = [
      { id: 'newer', conditions: [{ attribute: 'a', operator: 'matchesGlob', value: '*' }] },
      { id: 'known', conditions: [{ attribute: 'plan', operator: 'eq', value: 'pro' }] },
    ];
    const parsed = parseSegmentDefinition({ key: 's', rules }, warnings);

    expect(parsed.rules?.map((rule) => rule.id)).toEqual(['known']);
    expect(warnings[0]?.message).toMatch(/unsupported operator matchesGlob/u);
  });

  it('names the cause when dropping rules is what emptied the segment', () => {
    // The warnings explaining the drops go down with the segment, so the
    // rejection has to carry the reason: "needs a non-empty rules list" sends
    // an operator who wrote one looking for a field that is already there.
    expect(() =>
      parseSegmentDefinition({
        key: 's',
        rules: [{ id: 'newer', conditions: [{ attribute: 'a', operator: 'matchesGlob' }] }],
      }),
    ).toThrow(/every rule named an operator this version does not support/u);
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
