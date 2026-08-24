/**
 * Condition matching: the predicate half of targeting.
 *
 * Every matcher fails closed. A missing attribute, a value of the wrong type,
 * an unknown segment, an operator this version does not know — none of them
 * match, because "flag quietly on for everyone" is the failure mode a rollout
 * system must not have.
 */

import type { AttributeValue, EvaluationContext } from '../model/context.js';
import type { Condition } from '../model/flag.js';
import type { Segment, SegmentRule } from '../model/segment.js';
import { compareVersions } from './semver.js';

export type SegmentMap = ReadonlyMap<string, Segment>;

/** True when every condition of the rule holds for the context. */
export function matchesConditions(
  conditions: readonly Condition[],
  context: EvaluationContext,
  segments?: SegmentMap,
): boolean {
  return conditions.every((condition) => matchesCondition(condition, context, segments));
}

/**
 * Reads one attribute off a context.
 *
 * Own-property lookup: attribute names like `constructor` or `toString` must
 * read as absent, not resolve to Object.prototype members. Every read of a
 * context goes through here, so the rule holds for the attribute a split
 * buckets on exactly as it does for the ones conditions test.
 */
export function readAttribute(
  context: EvaluationContext,
  attribute: string,
): AttributeValue | undefined {
  return Object.hasOwn(context, attribute) ? context[attribute] : undefined;
}

/**
 * Evaluates a single predicate.
 *
 * Array-valued attributes are treated as sets: `in` and `contains` match when
 * any element matches, which is what callers expect from things like
 * `roles: ['admin', 'billing']`.
 */
export function matchesCondition(
  condition: Condition,
  context: EvaluationContext,
  segments?: SegmentMap,
): boolean {
  if (isSegmentCondition(condition)) {
    return matchesSegmentCondition(condition, context, segments);
  }

  const actual = readAttribute(context, condition.attribute);

  switch (condition.operator) {
    case 'exists': {
      return actual !== undefined;
    }
    case 'notExists': {
      return actual === undefined;
    }
    case 'eq': {
      return actual === condition.value;
    }
    case 'neq': {
      // Fail closed: an absent attribute is not evidence of inequality.
      return actual !== undefined && actual !== condition.value;
    }
    case 'in': {
      return isInList(actual, condition.value);
    }
    case 'notIn': {
      return actual !== undefined && !isInList(actual, condition.value);
    }
    case 'contains':
    case 'startsWith':
    case 'endsWith': {
      return matchesString(condition.operator, actual, condition.value);
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      return matchesNumber(condition.operator, actual, condition.value);
    }
    case 'semverEq':
    case 'semverGt':
    case 'semverGte':
    case 'semverLt':
    case 'semverLte': {
      return matchesVersion(condition.operator, actual, condition.value);
    }
    default: {
      // Unknown operator from a newer control plane: fail closed rather than
      // silently treating the rule as a match.
      return false;
    }
  }
}

/**
 * Segment membership, decided in strict order: `excluded` wins over
 * `included`, which wins over the rules. Segment rules are matched without a
 * segment map on purpose — membership never recurses (the parser rejects
 * segment operators inside segments, and a hand-built one fails closed here).
 *
 * This is exported, so it also meets segments that reached evaluation without
 * the compiler: every field is checked for the shape it claims rather than
 * trusted to the type, and one that does not have it fails closed.
 */
export function isInSegment(segment: Segment, context: EvaluationContext): boolean {
  const key = context.targetingKey;

  // An empty string is not an identity, here or anywhere else in evaluation.
  if (typeof key === 'string' && key.length > 0) {
    if (holds(segment.excluded, key)) return false;
    if (holds(segment.included, key)) return true;
  }

  for (const rule of rulesOf(segment)) {
    // The same rule as flag targeting applies: an empty condition list means
    // "everyone", so a rule carrying no list at all must not be read as one.
    if (!Array.isArray(rule.conditions)) continue;
    if (matchesConditions(rule.conditions, context)) return true;
  }

  return false;
}

/** Set membership that tolerates a segment the compiler never saw. */
function holds(keys: ReadonlySet<string>, key: string): boolean {
  return keys instanceof Set && keys.has(key);
}

const NO_RULES: readonly SegmentRule[] = [];

/**
 * The rule list of a segment that may never have been compiled.
 *
 * `Array.isArray` narrows an already-typed list to `any[]` and takes the
 * element type with it, so the assertion putting it back is confined here
 * rather than spread across the loop that uses it.
 */
function rulesOf(segment: Segment): readonly SegmentRule[] {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return Array.isArray(segment.rules) ? (segment.rules as readonly SegmentRule[]) : NO_RULES;
}

type SegmentCondition = Extract<Condition, { operator: 'inSegment' | 'notInSegment' }>;

/**
 * Membership across the listed segments. A segment that cannot be resolved —
 * dropped by the parser, or no segment map at all — makes membership
 * undecidable, so both operators fail closed: `inSegment` cannot match through
 * it, and `notInSegment` refuses to match rather than turning the rule on for
 * everyone it was written to exclude. Proven membership in a resolvable
 * segment still decides the condition either way.
 */
function matchesSegmentCondition(
  condition: SegmentCondition,
  context: EvaluationContext,
  segments?: SegmentMap,
): boolean {
  let member = false;
  let unresolved = false;

  for (const key of condition.segments) {
    const segment = segments?.get(key);
    if (segment === undefined) {
      unresolved = true;
      continue;
    }
    if (isInSegment(segment, context)) {
      member = true;
      break;
    }
  }

  if (condition.operator === 'inSegment') return member;
  return !member && !unresolved;
}

function isSegmentCondition(condition: Condition): condition is SegmentCondition {
  return condition.operator === 'inSegment' || condition.operator === 'notInSegment';
}

function isInList(actual: AttributeValue | undefined, list: readonly (string | number)[]): boolean {
  if (actual === undefined) return false;
  if (Array.isArray(actual)) {
    return (actual as readonly unknown[]).some(
      (item) => (typeof item === 'string' || typeof item === 'number') && list.includes(item),
    );
  }
  if (typeof actual === 'string' || typeof actual === 'number') return list.includes(actual);
  return false;
}

function matchesNumber(
  operator: 'gt' | 'gte' | 'lt' | 'lte',
  actual: AttributeValue | undefined,
  expected: number,
): boolean {
  if (typeof actual !== 'number') return false;

  switch (operator) {
    case 'gt': {
      return actual > expected;
    }
    case 'gte': {
      return actual >= expected;
    }
    case 'lt': {
      return actual < expected;
    }
    case 'lte': {
      return actual <= expected;
    }
  }
}

function matchesString(
  operator: 'contains' | 'startsWith' | 'endsWith',
  actual: AttributeValue | undefined,
  expected: string,
): boolean {
  if (operator === 'contains' && Array.isArray(actual)) {
    return (actual as readonly unknown[]).includes(expected);
  }
  if (typeof actual !== 'string') return false;

  switch (operator) {
    case 'contains': {
      return actual.includes(expected);
    }
    case 'startsWith': {
      return actual.startsWith(expected);
    }
    case 'endsWith': {
      return actual.endsWith(expected);
    }
  }
}

function matchesVersion(
  operator: 'semverEq' | 'semverGt' | 'semverGte' | 'semverLt' | 'semverLte',
  actual: AttributeValue | undefined,
  expected: string,
): boolean {
  if (typeof actual !== 'string') return false;

  const order = compareVersions(actual, expected);
  if (order === undefined) return false;

  switch (operator) {
    case 'semverEq': {
      return order === 0;
    }
    case 'semverGt': {
      return order > 0;
    }
    case 'semverGte': {
      return order >= 0;
    }
    case 'semverLt': {
      return order < 0;
    }
    case 'semverLte': {
      return order <= 0;
    }
  }
}
