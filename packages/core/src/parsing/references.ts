/**
 * Cross-document validation: the references one definition makes into another.
 *
 * A flag can be validated on its own — its own variant names, its own weights —
 * but a prerequisite's variant list, an `inSegment` key, and the shape of the
 * dependency graph only mean something against the rest of the payload. Those
 * are checked here, where `parseRuleset` has both sides in hand, rather than in
 * `parseFlagDefinition`, which sees one definition at a time.
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
const NO_EDGES: readonly string[] = [];

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

  checkPrerequisiteCycles(flags, issues);

  return issues;
}

/**
 * Reports every prerequisite cycle in the graph.
 *
 * A cycle is the one dangling-reference case where the safe behaviour is not
 * already good enough. The runtime guard in `evaluateFlag` does catch it and
 * names it, so nothing wrong is served — but the answer carries no value at
 * all, so every SDK falls back to its own hardcoded default, and it only
 * surfaces once a request reaches the flag. ADR 0006 keeps that guard as the
 * one that cannot be bypassed and calls a parse-time lint additive; this is
 * that lint. The graph is already in hand for the reference checks above.
 */
function checkPrerequisiteCycles(flags: readonly FlagDefinition[], issues: FlagParseIssue[]): void {
  const edges = new Map(
    flags.map((flag): [string, readonly string[]] => [
      flag.key,
      (flag.prerequisites ?? []).map((prerequisite) => prerequisite.flag),
    ]),
  );

  const done = new Set<string>();
  const onPath = new Set<string>();
  const reported = new Set<string>();

  for (const root of edges.keys()) {
    if (done.has(root)) continue;

    // Iterative: a definition can nest prerequisites far deeper than any real
    // graph, and the parser must not put its own stack at risk finding out.
    const stack: { readonly key: string; next: number }[] = [{ key: root, next: 0 }];
    onPath.add(root);

    while (stack.length > 0) {
      const frame = stack.at(-1)!;
      const neighbours = edges.get(frame.key) ?? NO_EDGES;

      if (frame.next >= neighbours.length) {
        onPath.delete(frame.key);
        done.add(frame.key);
        stack.pop();
        continue;
      }

      const next = neighbours[frame.next++]!;

      // Only an edge inside this ruleset can close a cycle; a dangling one is
      // already reported by checkPrerequisiteRefs.
      if (!edges.has(next)) continue;

      if (onPath.has(next)) {
        // One issue per flag that closes a cycle, not one per path into it.
        if (!reported.has(frame.key)) {
          reported.add(frame.key);
          issues.push({
            at: frame.key,
            message: `flag ${frame.key}: prerequisite ${next} closes a cycle`,
          });
        }
        continue;
      }

      if (done.has(next)) continue;

      onPath.add(next);
      stack.push({ key: next, next: 0 });
    }
  }
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
