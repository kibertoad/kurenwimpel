import type { SegmentDefinition } from '@kurenwimpel/core';

import { plural } from '../format/words.js';
import { pairByKey, sameJson, setDelta } from './compare.js';
import { change } from './types.js';
import type { Change } from './types.js';

/** Segment rules are OR'd, so their order is irrelevant and only membership is compared. */
export function diffSegment(before: SegmentDefinition, after: SegmentDefinition): Change[] {
  return [
    ...keyListChange('included', before.included ?? [], after.included ?? []),
    ...keyListChange('excluded', before.excluded ?? [], after.excluded ?? []),
    ...ruleChange(before, after),
  ];
}

function keyListChange(
  field: 'included' | 'excluded',
  before: readonly string[],
  after: readonly string[],
): Change[] {
  const { added, removed } = setDelta(before, after);
  if (added.length + removed.length === 0) return [];

  const effect =
    field === 'included'
      ? 'added keys join the segment, removed ones fall back to its rules'
      : 'added keys leave the segment whatever its rules say';
  return [
    change({
      kind: field === 'included' ? 'included-changed' : 'excluded-changed',
      at: field,
      added: added.length,
      removed: removed.length,
      summary: `${field}: ${plural(added.length, 'key')} added, ${removed.length} removed; ${effect}`,
    }),
  ];
}

function ruleChange(before: SegmentDefinition, after: SegmentDefinition): Change[] {
  const pairs = pairByKey(before.rules ?? [], after.rules ?? [], (rule) => rule.id);
  const added = pairs.filter((pair) => pair.before === undefined).length;
  const removed = pairs.filter((pair) => pair.after === undefined).length;
  const changed = pairs.filter(
    (pair) =>
      pair.before !== undefined &&
      pair.after !== undefined &&
      !sameJson(pair.before.conditions, pair.after.conditions),
  ).length;
  if (added + removed + changed === 0) return [];

  return [
    change({
      kind: 'segment-rules-changed',
      at: 'rules',
      added,
      removed,
      changed,
      summary: `rules: ${plural(added, 'rule')} added, ${removed} removed, ${changed} changed`,
    }),
  ];
}
