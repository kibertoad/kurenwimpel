/**
 * Flag evaluation. Pure and synchronous — no I/O, no clock, no throwing.
 * Malformed definitions surface as an `ERROR` result rather than an exception,
 * because this runs on request hot paths.
 *
 * The decision pipeline, in order:
 *
 * 1. `enabled: false` → the off variant. The kill switch; nothing else is consulted.
 * 2. A failed prerequisite → the off variant.
 * 3. An individual target listing the targeting key → its variant.
 * 4. Outside the traffic allocation → the default variant, `NOT_ALLOCATED`.
 * 5. The first rule whose conditions all match → its variant or rollout.
 * 6. The flag's own rollout, if it has one.
 * 7. The default variant.
 */

import type { EvaluationContext } from '../model/context.js';
import type { FlagDefinition, Prerequisite, Rollout, RolloutBucket } from '../model/flag.js';
import type { FlagValue } from '../model/json.js';
import { EvaluationErrorCode, EvaluationReason } from '../model/result.js';
import type { EvaluationResult } from '../model/result.js';
import { BUCKET_COUNT, bucketOf, isAllocated } from './bucketing.js';
import { matchesConditions } from './conditions.js';
import type { SegmentMap } from './conditions.js';

/**
 * What a flag may need beyond itself and the context: the other flags of its
 * snapshot (for prerequisites) and the segments (for segment conditions).
 * Everything is optional — a flag that uses neither evaluates without one, and
 * a missing lookup fails closed rather than throwing.
 */
export interface EvaluationEnvironment {
  readonly flags?: ReadonlyMap<string, FlagDefinition>;
  readonly segments?: SegmentMap;
}

/** Evaluates one flag against a context. The entry point of the whole core. */
export function evaluateFlag<T extends FlagValue = FlagValue>(
  flag: FlagDefinition<T>,
  context: EvaluationContext = {},
  environment: EvaluationEnvironment = {},
): EvaluationResult<T> {
  return evaluateGuarded(flag, context, environment, new Set([flag.key]));
}

/** The pipeline body; `visiting` carries the prerequisite chain for cycle detection. */
function evaluateGuarded<T extends FlagValue>(
  flag: FlagDefinition<T>,
  context: EvaluationContext,
  environment: EvaluationEnvironment,
  visiting: ReadonlySet<string>,
): EvaluationResult<T> {
  if (!flag.enabled) return resolve(flag, flag.offVariant, EvaluationReason.Disabled);

  const gate = checkPrerequisites(flag, context, environment, visiting);
  if (gate !== undefined) return gate;

  const targeted = matchTarget(flag, context.targetingKey);
  if (targeted !== undefined) return resolve(flag, targeted, EvaluationReason.TargetingMatch);

  const salt = flag.salt ?? flag.key;

  if (flag.allocation !== undefined) {
    if (context.targetingKey === undefined) return bucketingKeyMissing(flag, 'targetingKey');
    if (!isAllocated(flag.allocation, salt, context.targetingKey)) {
      return resolve(flag, flag.defaultVariant, EvaluationReason.NotAllocated);
    }
  }

  for (const rule of flag.rules ?? []) {
    if (!matchesConditions(rule.conditions, context, environment.segments)) continue;

    if (rule.rollout !== undefined) {
      const picked = pickVariant(rule.rollout, `${salt}:${rule.id}`, context);
      if (picked.missingAttribute !== undefined) {
        return bucketingKeyMissing(flag, picked.missingAttribute, rule.id);
      }
      if (picked.variant !== undefined) {
        return resolve(flag, picked.variant, EvaluationReason.Split, rule.id);
      }
    }

    if (rule.variant !== undefined) {
      return resolve(flag, rule.variant, EvaluationReason.TargetingMatch, rule.id);
    }
  }

  if (flag.rollout !== undefined) {
    const picked = pickVariant(flag.rollout, salt, context);
    if (picked.missingAttribute !== undefined) {
      return bucketingKeyMissing(flag, picked.missingAttribute);
    }
    if (picked.variant !== undefined) {
      return resolve(flag, picked.variant, EvaluationReason.Split);
    }
  }

  return resolve(flag, flag.defaultVariant, EvaluationReason.Static);
}

/**
 * Verifies every prerequisite: the flag must exist in the environment, be
 * enabled, and be serving one of the listed variants for this same context.
 * Returns the result to serve when a prerequisite fails, `undefined` when all
 * hold. A missing environment fails closed — a dependency that cannot be
 * checked is a dependency that does not hold.
 */
function checkPrerequisites<T extends FlagValue>(
  flag: FlagDefinition<T>,
  context: EvaluationContext,
  environment: EvaluationEnvironment,
  visiting: ReadonlySet<string>,
): EvaluationResult<T> | undefined {
  for (const prerequisite of flag.prerequisites ?? []) {
    if (visiting.has(prerequisite.flag)) {
      return invalidDefinition(
        flag,
        `Flag "${flag.key}" has a prerequisite cycle through "${prerequisite.flag}"`,
      );
    }

    const dependency = environment.flags?.get(prerequisite.flag);
    if (dependency === undefined || !dependency.enabled) {
      return prerequisiteFailed(flag, prerequisite);
    }

    const outcome = evaluateGuarded(
      dependency,
      context,
      environment,
      new Set([...visiting, prerequisite.flag]),
    );

    // A structurally broken dependency graph is reported as such, not disguised
    // as an ordinary failed prerequisite.
    if (outcome.errorCode === EvaluationErrorCode.InvalidDefinition) {
      return invalidDefinition(flag, outcome.errorMessage ?? 'invalid prerequisite');
    }

    if (outcome.variant === undefined || !prerequisite.variants.includes(outcome.variant)) {
      return prerequisiteFailed(flag, prerequisite);
    }
  }

  return undefined;
}

/** The variant an individual target pins this key to, if any. */
function matchTarget(flag: FlagDefinition, targetingKey: string | undefined): string | undefined {
  if (targetingKey === undefined || flag.targets === undefined) return undefined;
  return flag.targets.find((target) => target.keys.includes(targetingKey))?.variant;
}

interface PickOutcome {
  readonly variant?: string;
  /** Set when the attribute the split buckets on is absent from the context. */
  readonly missingAttribute?: string;
}

/** Resolves a split — either wire form — to a variant name. */
function pickVariant(rollout: Rollout, saltBase: string, context: EvaluationContext): PickOutcome {
  const split: RolloutSplitShape = 'buckets' in rollout ? rollout : { buckets: rollout };
  if (split.buckets.length === 0) return {};

  const key = bucketingKeyFor(split.bucketBy, context);
  if (key === undefined) return { missingAttribute: split.bucketBy ?? 'targetingKey' };

  const salt = split.seed === undefined ? saltBase : `${saltBase}!${split.seed}`;
  const variant = pickFromRollout(split.buckets, salt, key);
  return variant === undefined ? {} : { variant };
}

interface RolloutSplitShape {
  readonly buckets: readonly RolloutBucket[];
  readonly bucketBy?: string;
  readonly seed?: string;
}

/** The identity a split hashes: the targeting key, or the `bucketBy` attribute. */
function bucketingKeyFor(
  bucketBy: string | undefined,
  context: EvaluationContext,
): string | undefined {
  const raw = bucketBy === undefined ? context.targetingKey : context[bucketBy];
  if (typeof raw === 'string' && raw.length > 0) return raw;
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  return undefined;
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
  bucketingKey: string,
): string | undefined {
  let total = 0;
  for (const bucket of buckets) {
    if (bucket.weight > 0) total += bucket.weight;
  }
  if (total <= 0) return undefined;

  const point = (bucketOf(salt, bucketingKey) / BUCKET_COUNT) * total;

  let cumulative = 0;
  for (const bucket of buckets) {
    if (bucket.weight <= 0) continue;
    cumulative += bucket.weight;
    if (point < cumulative) return bucket.variant;
  }

  // Only reachable through floating-point drift at the very top of the range.
  return buckets.at(-1)?.variant;
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
      ...(flag.metadata === undefined ? {} : { metadata: flag.metadata }),
    };
  }

  return {
    key: flag.key,
    value,
    variant,
    reason,
    ...(ruleId === undefined ? {} : { ruleId }),
    ...(flag.metadata === undefined ? {} : { metadata: flag.metadata }),
  };
}

function prerequisiteFailed<T extends FlagValue>(
  flag: FlagDefinition<T>,
  prerequisite: Prerequisite,
): EvaluationResult<T> {
  return {
    ...resolve(flag, flag.offVariant, EvaluationReason.PrerequisiteFailed),
    failedPrerequisite: prerequisite.flag,
  };
}

function invalidDefinition<T extends FlagValue>(
  flag: FlagDefinition<T>,
  message: string,
): EvaluationResult<T> {
  return {
    key: flag.key,
    value: undefined,
    variant: undefined,
    reason: EvaluationReason.Error,
    errorCode: EvaluationErrorCode.InvalidDefinition,
    errorMessage: message,
    ...(flag.metadata === undefined ? {} : { metadata: flag.metadata }),
  };
}

/**
 * A split needs an identity to bucket against. Rather than failing the request
 * we serve the default variant and report the error alongside it, so callers
 * get a usable value and still see the misconfiguration.
 */
function bucketingKeyMissing<T extends FlagValue>(
  flag: FlagDefinition<T>,
  attribute: string,
  ruleId?: string,
): EvaluationResult<T> {
  return {
    ...resolve(flag, flag.defaultVariant, EvaluationReason.Static, ruleId),
    reason: EvaluationReason.Error,
    errorCode: EvaluationErrorCode.TargetingKeyMissing,
    errorMessage: `Flag "${flag.key}" buckets on "${attribute}", which is missing from the context`,
  };
}
