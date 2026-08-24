/**
 * Cross-document validation: the references one definition makes into another.
 *
 * A flag can be validated on its own — its own variant names, its own weights —
 * but a prerequisite's variant list and an `inSegment` key only mean something
 * against the rest of the payload. Those are checked here, where `parseRuleset`
 * has both sides in hand, rather than in `parseFlagDefinition`, which sees one
 * definition at a time.
 *
 * A dangling reference is reported, not dropped. Every one of them already
 * fails closed at evaluation — a prerequisite that cannot hold serves the off
 * variant, an unresolvable segment matches nobody — whereas dropping the flag
 * would answer FLAG_NOT_FOUND and send every SDK to its own hardcoded default
 * instead, which is the worse of the two failures. The issue is the part the
 * operator is missing; the safe behaviour is already there.
 */

import type { Condition, FlagDefinition } from '../model/flag.js';
import type { SegmentDefinition } from '../model/segment.js';
import type { FlagParseIssue } from './primitives.js';

const NO_SEGMENTS: readonly string[] = [];

/**
 * Checks every flag-to-flag and flag-to-segment reference in a parsed ruleset.
 *
 * `segmentsKnown` says whether the payload declared a segment side at all. A
 * bare array of flags does not, and its segments may be loaded from somewhere
 * else entirely — calling every `inSegment` in it dangling would be noise
 * rather than a finding.
 */
export function checkCrossReferences(
  flags: readonly FlagDefinition[],
  segments: readonly SegmentDefinition[],
  segmentsKnown: boolean,
): FlagParseIssue[] {
  const issues: FlagParseIssue[] = [];
  const variantsByFlag = new Map(
    flags.map((flag): [string, ReadonlySet<string>] => [
      flag.key,
      new Set(Object.keys(flag.variants)),
    ]),
  );
  const segmentKeys = segmentsKnown ? new Set(segments.map((segment) => segment.key)) : undefined;

  for (const flag of flags) {
    checkPrerequisiteRefs(flag, variantsByFlag, issues);
    if (segmentKeys !== undefined) checkSegmentRefs(flag, segmentKeys, issues);
  }

  return issues;
}

/**
 * A prerequisite names a flag and the variants that satisfy it. A typo in
 * either closes this flag for every subject, permanently and silently — the
 * result is indistinguishable from a deliberate kill switch, which is exactly
 * why it needs saying out loud.
 */
function checkPrerequisiteRefs(
  flag: FlagDefinition,
  variantsByFlag: ReadonlyMap<string, ReadonlySet<string>>,
  issues: FlagParseIssue[],
): void {
  for (const prerequisite of flag.prerequisites ?? []) {
    const variants = variantsByFlag.get(prerequisite.flag);

    if (variants === undefined) {
      issues.push({
        at: flag.key,
        message: `flag ${flag.key}: prerequisite ${prerequisite.flag} is not in this ruleset`,
      });
      continue;
    }

    for (const variant of prerequisite.variants) {
      if (variants.has(variant)) continue;
      issues.push({
        at: flag.key,
        message: `flag ${flag.key}: prerequisite ${prerequisite.flag} lists unknown variant ${variant}`,
      });
    }
  }
}

/** A misspelled segment key matches nobody, forever, without complaining. */
function checkSegmentRefs(
  flag: FlagDefinition,
  segmentKeys: ReadonlySet<string>,
  issues: FlagParseIssue[],
): void {
  for (const rule of flag.rules ?? []) {
    for (const condition of rule.conditions) {
      for (const key of segmentsOf(condition)) {
        if (segmentKeys.has(key)) continue;
        issues.push({
          at: flag.key,
          message: `flag ${flag.key}: rule ${rule.id} references unknown segment ${key}`,
        });
      }
    }
  }
}

/** The segment keys a condition references; empty for every other operator. */
function segmentsOf(condition: Condition): readonly string[] {
  return condition.operator === 'inSegment' || condition.operator === 'notInSegment'
    ? condition.segments
    : NO_SEGMENTS;
}
