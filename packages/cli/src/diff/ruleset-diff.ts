import type { Condition, FlagDefinition, SegmentDefinition } from '@kurenwimpel/core';

import { pairByKey } from './compare.js';
import { diffFlag } from './flag-diff.js';
import { diffSegment } from './segment-diff.js';
import type { Change, EntryStatus, FlagDiff, RulesetDiff, SegmentDiff } from './types.js';

export interface RulesetSide {
  readonly flags: readonly FlagDefinition[];
  readonly segments: readonly SegmentDefinition[];
}

/**
 * The semantic diff of two parsed rulesets. Unchanged flags and segments are
 * left out; entries come in the order of the new ruleset, then removed ones.
 */
export function diffRuleset(before: RulesetSide, after: RulesetSide): RulesetDiff {
  const flags = entries(before.flags, after.flags, diffFlag);

  const references = segmentReferences([...before.flags, ...after.flags]);
  const segments: SegmentDiff[] = [];
  for (const entry of entries(before.segments, after.segments, diffSegment)) {
    segments.push({ ...entry, referencedBy: references.get(entry.key) ?? [] });
  }

  const reshuffles = [...flags, ...segments].some((entry) =>
    entry.changes.some((item) => item.reshuffles),
  );
  return { flags, segments, reshuffles };
}

function entries<T extends { readonly key: string }>(
  before: readonly T[],
  after: readonly T[],
  diff: (before: T, after: T) => Change[],
): FlagDiff[] {
  const result: FlagDiff[] = [];
  for (const pair of pairByKey(before, after, (entry) => entry.key)) {
    const status: EntryStatus = statusOf(pair.before, pair.after);
    const changes = pair.before && pair.after ? diff(pair.before, pair.after) : [];
    if (status === 'changed' && changes.length === 0) continue;
    result.push({ key: pair.key, status, changes });
  }
  return result;
}

function statusOf(before: unknown, after: unknown): EntryStatus {
  if (before === undefined) return 'added';
  if (after === undefined) return 'removed';
  return 'changed';
}

function segmentReferences(flags: readonly FlagDefinition[]): Map<string, string[]> {
  const references = new Map<string, string[]>();
  for (const flag of flags) {
    for (const segment of namedSegments(flag)) {
      const list = references.get(segment) ?? [];
      if (!list.includes(flag.key)) list.push(flag.key);
      references.set(segment, list);
    }
  }
  return references;
}

function namedSegments(flag: FlagDefinition): string[] {
  const conditions: Condition[] = (flag.rules ?? []).flatMap((rule) => rule.conditions);
  return conditions.flatMap((condition) => ('segments' in condition ? condition.segments : []));
}
