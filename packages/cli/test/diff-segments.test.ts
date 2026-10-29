import { parseRuleset } from '@kurenwimpel/core';
import { describe, expect, it } from 'vitest';

import { diffRuleset } from '../src/index.js';
import type { SegmentDiff } from '../src/index.js';
import { readmeRuleset } from './fixtures.js';
import type { TestRuleset, TestSegment } from './fixtures.js';

function segmentDiffAfter(edit: (segment: TestSegment) => void): readonly SegmentDiff[] {
  const before = readmeRuleset();
  const after = readmeRuleset();
  edit(after.segments[0]!);
  return diffRuleset(parseRuleset(before), parseRuleset(after)).segments;
}

function withRules(...ids: string[]): TestRuleset {
  const ruleset = readmeRuleset();
  ruleset.segments[0]!.rules = ids.map((id) => ({
    id,
    conditions: [{ attribute: 'team', operator: 'eq', value: id }],
  }));
  return ruleset;
}

describe('diff, segments', () => {
  it('counts keys added to and removed from the included list', () => {
    const [entry] = segmentDiffAfter((segment) => {
      segment.included = ['emp-2', 'emp-3', 'emp-4', 'emp-5'];
    });
    expect(entry).toEqual({
      key: 'employees',
      status: 'changed',
      referencedBy: ['new-checkout'],
      changes: [expect.objectContaining({ kind: 'included-changed', added: 3, removed: 1 })],
    });
  });

  it('counts keys added to the excluded list', () => {
    const [entry] = segmentDiffAfter((segment) => {
      segment.excluded = ['emp-1'];
    });
    expect(entry?.changes).toEqual([
      expect.objectContaining({ kind: 'excluded-changed', added: 1, removed: 0 }),
    ]);
  });

  it('reports membership rules added, removed and changed', () => {
    const before = withRules('a', 'b');
    const after = withRules('a', 'c');
    after.segments[0]!.rules![0]!.conditions = [{ attribute: 'team', operator: 'neq', value: 'a' }];

    const [entry] = diffRuleset(parseRuleset(before), parseRuleset(after)).segments;
    expect(entry?.changes).toEqual([
      expect.objectContaining({ kind: 'segment-rules-changed', added: 1, removed: 1, changed: 1 }),
    ]);
  });

  it('ignores the order of membership rules, which are OR-ed', () => {
    const diff = diffRuleset(parseRuleset(withRules('a', 'b')), parseRuleset(withRules('b', 'a')));
    expect(diff.segments).toEqual([]);
  });

  it('reports a removed segment along with the flags still naming it', () => {
    const before = readmeRuleset();
    const after = readmeRuleset();
    after.segments = [];

    expect(diffRuleset(parseRuleset(before), parseRuleset(after)).segments).toEqual([
      { key: 'employees', status: 'removed', referencedBy: ['new-checkout'], changes: [] },
    ]);
  });
});
