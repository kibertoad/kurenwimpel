import { BUCKET_COUNT, bucketOf } from './hash.js';
import type {
  AttributeValue,
  Condition,
  EvaluationContext,
  EvaluationResult,
  FlagDefinition,
  FlagValue,
  RolloutBucket,
  TargetingRule,
} from './types.js';
import { EvaluationErrorCode, EvaluationReason } from './types.js';

/** Attribute name that reads {@link EvaluationContext.targetingKey} instead of the attribute bag. */
export const TARGETING_KEY_ATTRIBUTE = 'targetingKey';

function readAttribute(context: EvaluationContext, attribute: string): AttributeValue | undefined {
  if (attribute === TARGETING_KEY_ATTRIBUTE) return context.targetingKey;
  return context.attributes?.[attribute];
}

/** True when every condition of the rule holds for the context. */
export function matchesRule(rule: TargetingRule, context: EvaluationContext): boolean {
  return rule.conditions.every((condition) => matchesCondition(condition, context));
}

/**
 * Evaluates a single predicate.
 *
 * Array-valued attributes are treated as sets: `in` and `contains` match when
 * any element matches, which is what callers expect from things like
 * `roles: ['admin', 'billing']`.
 */
export function matchesCondition(condition: Condition, context: EvaluationContext): boolean {
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
      return actual !== condition.value;
    }
    case 'in': {
      return isInList(actual, condition.value);
    }
    case 'notIn': {
      return actual !== undefined && !isInList(actual, condition.value);
    }
    case 'contains': {
      if (Array.isArray(actual)) return (actual as readonly unknown[]).includes(condition.value);
      return typeof actual === 'string' && actual.includes(condition.value);
    }
    case 'startsWith': {
      return typeof actual === 'string' && actual.startsWith(condition.value);
    }
    case 'endsWith': {
      return typeof actual === 'string' && actual.endsWith(condition.value);
    }
    case 'gt': {
      return typeof actual === 'number' && actual > condition.value;
    }
    case 'gte': {
      return typeof actual === 'number' && actual >= condition.value;
    }
    case 'lt': {
      return typeof actual === 'number' && actual < condition.value;
    }
    case 'lte': {
      return typeof actual === 'number' && actual <= condition.value;
    }
    default: {
      // Unknown operator from a newer control plane: fail closed rather than
      // silently treating the rule as a match.
      return false;
    }
  }
}

function isInList(actual: AttributeValue | undefined, list: readonly (string | number)[]): boolean {
  if (actual === undefined) return false;
  if (Array.isArray(actual)) {
    return (actual as readonly (string | number)[]).some((item) => list.includes(item));
  }
  if (typeof actual === 'string' || typeof actual === 'number') return list.includes(actual);
  return false;
}

/**
 * Picks a variant from a weighted split.
 *
 * Weights are relative: `[{a, 1}, {b, 3}]` is a 25/75 split. Returns
 * `undefined` when the split carries no usable weight.
 */
export function pickFromRollout(
  buckets: readonly RolloutBucket[],
  salt: string,
  targetingKey: string,
): string | undefined {
  let total = 0;
  for (const bucket of buckets) {
    if (bucket.weight > 0) total += bucket.weight;
  }
  if (total <= 0) return undefined;

  const point = (bucketOf(salt, targetingKey) / BUCKET_COUNT) * total;

  let cumulative = 0;
  for (const bucket of buckets) {
    if (bucket.weight <= 0) continue;
    cumulative += bucket.weight;
    if (point < cumulative) return bucket.variant;
  }

  // Only reachable through floating-point drift at the very top of the range.
  return buckets.at(-1)?.variant;
}

/**
 * Evaluates a flag definition against a context. Pure and synchronous — no I/O,
 * no clock, no throwing. Malformed definitions surface as an `ERROR` result
 * rather than an exception, because this runs on request hot paths.
 */
export function evaluateFlag<T extends FlagValue = FlagValue>(
  flag: FlagDefinition<T>,
  context: EvaluationContext = {},
): EvaluationResult<T> {
  if (!flag.enabled) {
    return resolve(flag, flag.offVariant, EvaluationReason.Disabled);
  }

  const salt = flag.salt ?? flag.key;

  for (const rule of flag.rules ?? []) {
    if (!matchesRule(rule, context)) continue;

    if (rule.rollout !== undefined && rule.rollout.length > 0) {
      if (context.targetingKey === undefined) {
        return targetingKeyMissing(flag, rule.id);
      }
      const variant = pickFromRollout(rule.rollout, `${salt}:${rule.id}`, context.targetingKey);
      if (variant !== undefined) {
        return resolve(flag, variant, EvaluationReason.Split, rule.id);
      }
    }

    if (rule.variant !== undefined) {
      return resolve(flag, rule.variant, EvaluationReason.TargetingMatch, rule.id);
    }
  }

  if (flag.rollout !== undefined && flag.rollout.length > 0) {
    if (context.targetingKey === undefined) {
      return targetingKeyMissing(flag);
    }
    const variant = pickFromRollout(flag.rollout, salt, context.targetingKey);
    if (variant !== undefined) {
      return resolve(flag, variant, EvaluationReason.Split);
    }
  }

  return resolve(flag, flag.defaultVariant, EvaluationReason.Default);
}

function resolve<T extends FlagValue>(
  flag: FlagDefinition<T>,
  variant: string,
  reason: Exclude<EvaluationReason, 'ERROR'>,
  ruleId?: string,
): EvaluationResult<T> {
  const value = flag.variants[variant];

  if (value === undefined) {
    return {
      key: flag.key,
      value: undefined,
      variant: undefined,
      reason: EvaluationReason.Error,
      errorCode: EvaluationErrorCode.VariantNotFound,
      errorMessage: `Flag "${flag.key}" has no variant "${variant}"`,
      ...(ruleId === undefined ? {} : { ruleId }),
    };
  }

  return {
    key: flag.key,
    value,
    variant,
    reason,
    ...(ruleId === undefined ? {} : { ruleId }),
  };
}

/**
 * A rollout needs a targeting key to bucket against. Rather than failing the
 * request we serve the default variant and report the error alongside it, so
 * callers get a usable value and still see the misconfiguration.
 */
function targetingKeyMissing<T extends FlagValue>(
  flag: FlagDefinition<T>,
  ruleId?: string,
): EvaluationResult<T> {
  const fallback = resolve(flag, flag.defaultVariant, EvaluationReason.Default, ruleId);

  return {
    ...fallback,
    reason: EvaluationReason.Error,
    errorCode: EvaluationErrorCode.TargetingKeyMissing,
    errorMessage: `Flag "${flag.key}" needs a targeting key to evaluate its rollout`,
  };
}
