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
 * 5. The first rule whose conditions all match decides, and nothing below it is
 *    consulted: its rollout, else its variant, else — for a rollout parked at
 *    zero — the default variant.
 * 6. The flag's own rollout, if no rule matched.
 * 7. The default variant.
 */

import type { EvaluationContext } from '../model/context.js';
import type {
  FlagDefinition,
  Prerequisite,
  Rollout,
  RolloutBucket,
  RolloutSplit,
} from '../model/flag.js';
import type { FlagValue } from '../model/json.js';
import { EvaluationErrorCode, EvaluationReason } from '../model/result.js';
import type { EvaluationResult } from '../model/result.js';
import { BUCKET_COUNT, bucketOf, isAllocated } from './bucketing.js';
import { matchesConditions } from './conditions.js';
import type { SegmentMap } from './conditions.js';
import type { TargetIndex } from './targets.js';

/**
 * What a flag may need beyond itself and the context: the other flags of its
 * snapshot (for prerequisites), the segments (for segment conditions), and the
 * compiled individual-target lookup. Everything is optional — a flag that uses
 * none of them evaluates without one, and a missing lookup fails closed rather
 * than throwing.
 */
export interface EvaluationEnvironment {
  readonly flags?: ReadonlyMap<string, FlagDefinition>;
  readonly segments?: SegmentMap;
  readonly targetIndex?: TargetIndex;
}

/**
 * How deep a prerequisite chain may be before it is treated as a broken
 * definition: far past any real dependency graph, and short enough that the
 * recursion cannot exhaust the stack on the way to finding out.
 */
const MAX_PREREQUISITE_DEPTH = 50;

/**
 * Prerequisite bookkeeping for one evaluation.
 *
 * `memo` is what keeps the walk linear. Two flags that share a dependency must
 * cost one evaluation of it, not one per path that reaches it — otherwise a
 * chain of depth n costs 2^n, and a control plane can turn a single lookup into
 * seconds of CPU. Every entry was computed against the same context, which is
 * fixed for the whole walk.
 */
interface PrerequisiteWalk {
  /** The flags on the current chain. Meeting one of them again is a cycle. */
  readonly visiting: ReadonlySet<string>;
  readonly memo: Map<string, EvaluationResult>;
}

/** Evaluates one flag against a context. The entry point of the whole core. */
export function evaluateFlag<T extends FlagValue = FlagValue>(
  flag: FlagDefinition<T>,
  context: EvaluationContext = {},
  environment: EvaluationEnvironment = {},
): EvaluationResult<T> {
  try {
    return evaluateGuarded(flag, context, environment, {
      visiting: new Set([flag.key]),
      memo: new Map(),
    });
  } catch (error) {
    // The no-throw contract has to hold for definitions that never went through
    // the parser too. A shape it would have rejected degrades to an ERROR
    // result rather than taking down the handler that hand-built it.
    const detail = error instanceof Error ? error.message : String(error);
    return invalidDefinition(flag, `Flag "${flag.key}" is not a usable definition: ${detail}`);
  }
}

/** The pipeline body; `walk` carries the prerequisite chain and its memo. */
function evaluateGuarded<T extends FlagValue>(
  flag: FlagDefinition<T>,
  context: EvaluationContext,
  environment: EvaluationEnvironment,
  walk: PrerequisiteWalk,
): EvaluationResult<T> {
  if (!flag.enabled) return resolve(flag, flag.offVariant, EvaluationReason.Disabled);

  const gate = checkPrerequisites(flag, context, environment, walk);
  if (gate !== undefined) return gate;

  const targeted = matchTarget(flag, context.targetingKey, environment.targetIndex);
  if (targeted !== undefined) return resolve(flag, targeted, EvaluationReason.TargetingMatch);

  const salt = flag.salt ?? flag.key;

  if (flag.allocation !== undefined) {
    // The same identity rule as every split: a present, non-empty key.
    const { bucketBy } = flag.allocation;
    const allocationKey = bucketingKeyFor(bucketBy, context);
    if (allocationKey === undefined) return bucketingKeyMissing(flag, bucketBy ?? 'targetingKey');
    if (!isAllocated(flag.allocation, salt, allocationKey)) {
      return resolve(flag, flag.defaultVariant, EvaluationReason.NotAllocated);
    }
  }

  const ruled = matchRule(flag, context, environment, salt);
  if (ruled !== undefined) return ruled;

  if (flag.rollout !== undefined) {
    const picked = pickVariant(flag.rollout, ['rollout', salt], context);
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
 * The outcome of the first rule whose conditions all match, or `undefined` when
 * none did.
 *
 * The first match is final. A matched rule whose rollout carries no weight — a
 * parked experiment — serves the flag's default variant; letting it fall
 * through would silently promote the next rule to production the moment an
 * experiment is paused.
 */
function matchRule<T extends FlagValue>(
  flag: FlagDefinition<T>,
  context: EvaluationContext,
  environment: EvaluationEnvironment,
  salt: string,
): EvaluationResult<T> | undefined {
  for (const rule of flag.rules ?? []) {
    // An empty condition list means "everyone", so a rule carrying no list at
    // all must not be read as one: fail closed and skip it.
    if (!Array.isArray(rule.conditions)) continue;
    if (!matchesConditions(rule.conditions, context, environment.segments)) continue;

    if (rule.rollout !== undefined) {
      const picked = pickVariant(rule.rollout, ['rule', salt, rule.id], context);
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

    return resolve(flag, flag.defaultVariant, EvaluationReason.Static, rule.id);
  }

  return undefined;
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
  walk: PrerequisiteWalk,
): EvaluationResult<T> | undefined {
  if (walk.visiting.size > MAX_PREREQUISITE_DEPTH) {
    return invalidDefinition(
      flag,
      `Flag "${flag.key}" sits more than ${MAX_PREREQUISITE_DEPTH} prerequisites deep`,
    );
  }

  for (const prerequisite of flag.prerequisites ?? []) {
    if (walk.visiting.has(prerequisite.flag)) {
      return invalidDefinition(
        flag,
        `Flag "${flag.key}" has a prerequisite cycle through "${prerequisite.flag}"`,
      );
    }

    const dependency = environment.flags?.get(prerequisite.flag);
    if (dependency === undefined || !dependency.enabled) {
      return prerequisiteFailed(flag, prerequisite);
    }

    const outcome = evaluateDependency(dependency, context, environment, walk);

    // A structurally broken dependency graph is reported as such, not disguised
    // as an ordinary failed prerequisite.
    if (outcome.errorCode === EvaluationErrorCode.InvalidDefinition) {
      return invalidDefinition(flag, outcome.errorMessage ?? 'invalid prerequisite');
    }

    // An errored dependency serves its fallback variant, which vouches for
    // nothing — a dependency that cannot be evaluated is a dependency that
    // does not hold.
    if (
      outcome.errorCode !== undefined ||
      outcome.variant === undefined ||
      !prerequisite.variants.includes(outcome.variant)
    ) {
      return prerequisiteFailed(flag, prerequisite);
    }
  }

  return undefined;
}

/** One dependency, evaluated at most once per request. See {@link PrerequisiteWalk}. */
function evaluateDependency(
  dependency: FlagDefinition,
  context: EvaluationContext,
  environment: EvaluationEnvironment,
  walk: PrerequisiteWalk,
): EvaluationResult {
  const cached = walk.memo.get(dependency.key);
  if (cached !== undefined) return cached;

  const outcome = evaluateGuarded(dependency, context, environment, {
    visiting: new Set([...walk.visiting, dependency.key]),
    memo: walk.memo,
  });

  walk.memo.set(dependency.key, outcome);
  return outcome;
}

/** The variant an individual target pins this key to, if any. */
function matchTarget(
  flag: FlagDefinition,
  targetingKey: string | undefined,
  index: TargetIndex | undefined,
): string | undefined {
  // An empty string is not an identity: it cannot be individually targeted.
  if (targetingKey === undefined || targetingKey.length === 0) return undefined;

  // A snapshot has folded every flag's targets into one lookup, so the request
  // path is a single probe however many keys are listed.
  const compiled = index?.get(flag.key);
  if (compiled !== undefined) return compiled.get(targetingKey);

  if (flag.targets === undefined) return undefined;
  // A target whose keys are not a list fails closed, exactly as it does when
  // compiled — a bare string would otherwise match on any substring of itself.
  return flag.targets.find(
    (target) => Array.isArray(target.keys) && target.keys.includes(targetingKey),
  )?.variant;
}

interface PickOutcome {
  readonly variant?: string;
  /** Set when the attribute the split buckets on is absent from the context. */
  readonly missingAttribute?: string;
}

/** Resolves a split — either wire form — to a variant name. */
function pickVariant(
  rollout: Rollout,
  domain: readonly string[],
  context: EvaluationContext,
): PickOutcome {
  const split = isSplitObject(rollout) ? rollout : { buckets: rollout };
  if (!Array.isArray(split.buckets) || split.buckets.length === 0) return {};

  const key = bucketingKeyFor(split.bucketBy, context);
  if (key === undefined) return { missingAttribute: split.bucketBy ?? 'targetingKey' };

  const seeded = split.seed === undefined ? domain : [...domain, split.seed];
  const variant = pickFromRollout(split.buckets, seeded, key);
  return variant === undefined ? {} : { variant };
}

/**
 * Tells the two wire forms of a split apart.
 *
 * Not being an array is the discriminant. Testing for a `buckets` property
 * instead would wrap a hand-built `{ bucketBy }` — which has no buckets at all
 * — into a split whose bucket list is that very object.
 */
function isSplitObject(rollout: Rollout): rollout is RolloutSplit {
  return !Array.isArray(rollout);
}

/** The identity a split hashes: the targeting key, or the `bucketBy` attribute. */
function bucketingKeyFor(
  bucketBy: string | undefined,
  context: EvaluationContext,
): string | undefined {
  const raw =
    bucketBy === undefined
      ? context.targetingKey
      : Object.hasOwn(context, bucketBy)
        ? context[bucketBy]
        : undefined;
  if (typeof raw === 'string' && raw.length > 0) return raw;
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  return undefined;
}

/**
 * Picks a variant from a weighted split.
 *
 * Weights are relative: `[{a, 1}, {b, 3}]` is a 25/75 split. Returns
 * `undefined` when the split carries no usable weight — all-zero, or a total
 * that overflows to Infinity (hand-built flags bypass the parser).
 */
export function pickFromRollout(
  buckets: readonly RolloutBucket[],
  domain: readonly string[],
  bucketingKey: string,
): string | undefined {
  let total = 0;
  for (const bucket of buckets) {
    if (bucket.weight > 0) total += bucket.weight;
  }
  if (total <= 0 || !Number.isFinite(total)) return undefined;

  const point = (bucketOf(domain, bucketingKey) / BUCKET_COUNT) * total;

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
  // Own-property lookup: a variant named `constructor` in a hand-built flag
  // must be VARIANT_NOT_FOUND, not an Object.prototype member.
  const value = Object.hasOwn(flag.variants, variant) ? flag.variants[variant] : undefined;

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
  const served = resolve(flag, flag.defaultVariant, EvaluationReason.Static, ruleId);

  // A default variant that does not exist is its own defect, and the more
  // urgent one. Keep that diagnosis rather than overwriting it with the
  // bucketing complaint, which would send the operator after the wrong thing.
  if (served.errorCode !== undefined) return served;

  return {
    ...served,
    reason: EvaluationReason.Error,
    errorCode: EvaluationErrorCode.TargetingKeyMissing,
    errorMessage: `Flag "${flag.key}" buckets on "${attribute}", which is missing from the context`,
  };
}
