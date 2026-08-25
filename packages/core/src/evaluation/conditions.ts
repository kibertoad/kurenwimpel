/**
 * Condition matching: the predicate half of targeting.
 *
 * Every matcher fails closed. A missing attribute, a value of the wrong type,
 * an unknown segment, an operator this version does not know — none of them
 * match, because "flag quietly on for everyone" is the failure mode a rollout
 * system must not have.
 */

import type { AttributeValue, EvaluationContext } from '../model/context.js';
import type { Condition, TargetingRule } from '../model/flag.js';
import type { Segment, SegmentDefinition, SegmentRule } from '../model/segment.js';
import { isRecord } from '../parsing/primitives.js';
import { readySegment } from './segments.js';
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
 * Whether one rule of a flag or of a segment matches — the check that decides
 * whether a rule can be matched at all, and then whether it does.
 *
 * An empty condition list means "everyone", so a rule carrying no list at all
 * must not be read as one: it fails closed and is skipped, and so is a rule
 * that is not an object in the first place. Hand-built definitions reach both
 * callers, and the guard used to be written out in each of them, comment and
 * all — the shape that has already let two copies of `isKeyedDefinition` drift
 * apart over whether an array counts.
 */
export function matchesRule(
  rule: TargetingRule | SegmentRule,
  context: EvaluationContext,
  segments?: SegmentMap,
): boolean {
  if (!isRecord(rule) || !Array.isArray(rule.conditions)) return false;
  return matchesConditions(rule.conditions, context, segments);
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
 * The one rule for reading an identity off an attribute: a non-empty string,
 * or a finite number spelled as one.
 *
 * Numbers are accepted because handing over `targetingKey: user.id` from a
 * numeric id column is the ordinary case, and a context takes any JSON. What
 * matters is that every consumer applies the *same* rule. Bucketing used to
 * coerce numbers while individual targets and a segment's included and
 * excluded lists rejected them, so a numeric key was split normally, matched
 * no target that named it, and walked straight past the exclusion list that
 * named it too — the one guarantee segments make unconditionally.
 */
export function identityOf(raw: AttributeValue | undefined): string | undefined {
  if (typeof raw === 'string') return raw.length > 0 ? raw : undefined;
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  return undefined;
}

/**
 * The identity a context carries, under the same own-property rule as every
 * other attribute, and the same {@link identityOf} rule everywhere it is used.
 *
 * Reading `context.targetingKey` directly instead would make the one attribute
 * that decides bucketing and individual targeting the one attribute read off
 * the prototype chain: a context inheriting a targeting key would be bucketed
 * on it while `targetingKey exists` answered false for the same subject.
 */
export function readTargetingKey(context: EvaluationContext): string | undefined {
  return identityOf(readAttribute(context, 'targetingKey'));
}

/**
 * The value a condition tests, which for the targeting key is the identity it
 * resolves to and for every other attribute is whatever the context holds.
 *
 * The targeting key is the one attribute that is always an identity, so the
 * rule {@link identityOf} states — every consumer applies the *same* one — has
 * to reach conditions too, or a context answers two ways about a single
 * attribute. It closed the prototype-chain half of that split and left the
 * rest: `targetingKey: ''` read as present to `exists` and served a variant
 * off it, while the very same context was TARGETING_KEY_MISSING to every
 * bucketed path; `targetingKey: 42` matched `eq: 42` here while the included
 * list of a segment, individual targets, and bucketing all knew it as "42".
 *
 * Only the targeting key. `bucketBy` can promote any attribute to an identity
 * for one flag, but a condition cannot know which — and `plan: ''` is an
 * ordinary empty attribute that `exists` should answer for truthfully.
 */
function readConditionValue(
  context: EvaluationContext,
  attribute: string,
): AttributeValue | undefined {
  return attribute === 'targetingKey'
    ? readTargetingKey(context)
    : readAttribute(context, attribute);
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

  const actual = readConditionValue(context, condition.attribute);

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
      return listMembership(actual, condition.value) === true;
    }
    case 'notIn': {
      // Neither operator matches while membership is undecidable, so an absent
      // attribute is not evidence of exclusion and a malformed list does not
      // turn the rule on for everyone it was written to exclude.
      return listMembership(actual, condition.value) === false;
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
 * the compiler — hand-built, half-compiled, or straight off a JSON payload.
 * Whether a segment has the compiled shape is asked once, here, and answered
 * by putting it through the compiler if it does not. That check used to be
 * spread over one helper per field, which re-derived the same invariant on
 * every membership test and still read a segment carrying its key lists as
 * plain arrays — a perfectly ordinary {@link SegmentDefinition} — as a segment
 * with no keys in it at all.
 *
 * The compiling itself is paid once per definition rather than once per test;
 * see {@link readySegment}.
 */
export function isInSegment(
  segment: Segment | SegmentDefinition,
  context: EvaluationContext,
): boolean {
  return matchesCompiledSegment(readySegment(segment), context);
}

/** Membership against a segment already known to have the compiled shape. */
function matchesCompiledSegment(segment: Segment, context: EvaluationContext): boolean {
  // An empty string is not an identity, here or anywhere else in evaluation.
  const key = readTargetingKey(context);

  if (key !== undefined) {
    if (segment.excluded.has(key)) return false;
    if (segment.included.has(key)) return true;
  }

  for (const rule of segment.rules) {
    // Matched without a segment map, and skipped when it cannot be matched at
    // all — see {@link matchesRule}. The compiler validates that a segment has
    // rules, not what is in them.
    if (matchesRule(rule, context)) return true;
  }

  return false;
}

type SegmentCondition = Extract<Condition, { operator: 'inSegment' | 'notInSegment' }>;

/**
 * Membership across the listed segments. A segment that cannot be resolved —
 * dropped by the parser, or no segment map at all — makes membership
 * undecidable, so both operators fail closed: `inSegment` cannot match through
 * it, and `notInSegment` refuses to match rather than turning the rule on for
 * everyone it was written to exclude. Proven membership in a resolvable
 * segment still decides the condition either way.
 *
 * A condition whose `segments` is not a list at all names nothing resolvable,
 * so it is the same answer: neither operator matches. Checked rather than
 * trusted to the type, like every other list the matcher walks — a hand-built
 * condition missing the field would otherwise throw out of the one module
 * documented to fail closed, and take the whole flag down to an ERROR result
 * over a single malformed rule.
 */
function matchesSegmentCondition(
  condition: SegmentCondition,
  context: EvaluationContext,
  segments?: SegmentMap,
): boolean {
  if (!namesSegments(condition)) return false;

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

/**
 * Whether the condition's segment list really is a list.
 *
 * A plain boolean rather than a type predicate: `Array.isArray` narrows an
 * already-typed list to `any[]` and takes the element type with it, so the
 * caller would end up walking `any` keys.
 */
function namesSegments(condition: SegmentCondition): boolean {
  return Array.isArray(condition.segments);
}

function isSegmentCondition(condition: Condition): condition is SegmentCondition {
  return condition.operator === 'inSegment' || condition.operator === 'notInSegment';
}

/**
 * Set membership, as a tri-state: `true` in, `false` out, `undefined` when the
 * question cannot be answered at all.
 *
 * The undecidable case is what keeps `notIn` honest. A hand-built or JSON-cast
 * condition can carry a scalar where the type promises a list, and reading
 * that as an empty set would answer "not a member" for everyone — turning a
 * rule written to exclude a cohort into one that matches the whole world.
 * Trusting the type instead is worse still: `list.includes` on a string is
 * substring matching, so `plan in ['pro']` written as `plan in 'pro'` would
 * match every plan spelled with any substring of it.
 */
function listMembership(
  actual: AttributeValue | undefined,
  list: readonly (string | number)[],
): boolean | undefined {
  if (actual === undefined) return undefined;
  if (!Array.isArray(list)) return undefined;

  if (Array.isArray(actual)) {
    return (actual as readonly unknown[]).some(
      (item) => (typeof item === 'string' || typeof item === 'number') && list.includes(item),
    );
  }
  if (typeof actual === 'string' || typeof actual === 'number') return list.includes(actual);

  // An attribute of a type no list can hold — an object, a boolean, a null —
  // is out of the set rather than unanswerable: `notIn` should match it.
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

/**
 * An array-valued attribute is treated as a set: `contains` matches when any
 * element does.
 *
 * Any element *contains* it, not any element equals it — the operator has to
 * mean the same thing whatever type the attribute happens to have. Element
 * equality made `roles: ['administrator']` fail a `contains: 'admin'` rule
 * that `roles: 'administrator'` passed, so an operator who wrote the rule
 * against a list and tested it against a single-valued context got the
 * opposite answer from the one they shipped. Equality still matches, being the
 * substring case where the whole element is the substring; nothing that
 * matched before stops matching.
 *
 * Elements of a type no substring test can read are skipped rather than
 * compared, which is the filter {@link listMembership} already applies.
 */
function matchesString(
  operator: 'contains' | 'startsWith' | 'endsWith',
  actual: AttributeValue | undefined,
  expected: string,
): boolean {
  if (operator === 'contains' && Array.isArray(actual)) {
    return (actual as readonly unknown[]).some(
      (item) => typeof item === 'string' && item.includes(expected),
    );
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
