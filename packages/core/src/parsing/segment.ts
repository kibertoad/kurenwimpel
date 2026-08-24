/**
 * Validation for segment definitions.
 */

import type { SegmentDefinition, SegmentRule } from '../model/segment.js';
import { parseCondition } from './condition.js';
import { fail, isDroppedRule, isRecord, requireString, requireStringArray } from './primitives.js';
import type { FlagParseIssue } from './primitives.js';

/**
 * Validates one segment definition.
 *
 * `warnings` collects the defects that do not cost the segment — a rule naming
 * an operator this version does not know. Omit it and they are simply dropped.
 *
 * @throws {FlagParseError} when the shape is not a usable segment.
 */
export function parseSegmentDefinition(
  raw: unknown,
  warnings?: FlagParseIssue[],
): SegmentDefinition {
  if (!isRecord(raw)) fail('segment must be an object');

  const key = requireString(raw['key'], 'segment key');
  const included = parseKeyList(raw['included'], key, 'included');
  const excluded = parseKeyList(raw['excluded'], key, 'excluded');
  const rawRules = raw['rules'];
  const rules = parseSegmentRules(rawRules, key, warnings);

  // Content, not presence. A segment whose criteria are all empty lists can
  // never match anybody, so every `inSegment` naming it matches nobody and
  // every `notInSegment` matches everybody, forever and without complaint —
  // the same silence a misspelled segment key is checked for in
  // `references.ts`, reached through a different door. An operator who emptied
  // the list in the UI gets an issue rather than nothing.
  //
  // Dropped rules reach the same end, and the warnings explaining them are
  // discarded along with the segment, so the message has to carry the cause
  // itself — "needs a non-empty rules list" sends an operator who wrote one
  // looking for a field that is already there.
  const criteria = (included?.length ?? 0) + (excluded?.length ?? 0) + (rules?.length ?? 0);
  if (criteria === 0) {
    fail(
      declaredRules(rawRules) === 0
        ? `segment ${key}: needs a non-empty included, excluded, or rules list`
        : `segment ${key}: every rule named an operator this version does not support`,
    );
  }

  return {
    key,
    ...(included === undefined ? {} : { included }),
    ...(excluded === undefined ? {} : { excluded }),
    ...(rules === undefined ? {} : { rules }),
  };
}

/** How many rules the definition declared, before any were dropped. */
function declaredRules(raw: unknown): number {
  return Array.isArray(raw) ? raw.length : 0;
}

function parseKeyList(
  raw: unknown,
  key: string,
  field: 'included' | 'excluded',
): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  return requireStringArray(raw, `segment ${key}: ${field}`);
}

/**
 * The segment's rules, minus any naming an operator this version does not
 * know. Those are dropped and reported rather than costing the segment, for
 * the reason {@link ParseFailureScope} gives: such a rule can never grant
 * membership, so dropping it decides nothing differently.
 *
 * A segment left with no usable criteria at all is still rejected by the
 * caller's content check — an audience that can never match anybody is worth
 * an issue, whichever way it got there.
 */
function parseSegmentRules(
  raw: unknown,
  key: string,
  warnings: FlagParseIssue[] | undefined,
): SegmentRule[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) fail(`segment ${key}: rules must be an array`);

  const rules: SegmentRule[] = [];

  for (const [index, entry] of (raw as unknown[]).entries()) {
    try {
      rules.push(parseSegmentRule(entry, index, key));
    } catch (error) {
      if (!isDroppedRule(error)) throw error;
      warnings?.push({
        at: key,
        message: `${error.message} — the rule is dropped, the segment is still served`,
      });
    }
  }

  return rules;
}

function parseSegmentRule(entry: unknown, index: number, key: string): SegmentRule {
  if (!isRecord(entry)) fail(`segment ${key}: rule ${index} must be an object`);

  const id = requireString(entry['id'], `segment ${key}: rule ${index} id`);
  const conditionsRaw = entry['conditions'];
  if (!Array.isArray(conditionsRaw) || conditionsRaw.length === 0) {
    fail(`segment ${key}: rule ${id} needs a non-empty conditions array`);
  }

  // Segment operators are rejected inside segment rules: membership that
  // cannot recurse is membership that cannot cycle.
  const conditions = conditionsRaw.map((condition: unknown) =>
    parseCondition(condition, `segment ${key}: rule ${id}`, false),
  );

  return { id, conditions };
}
