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
import type { FlagDefinition, Prerequisite } from '../model/flag.js';
import type { FlagValue } from '../model/json.js';
import { EvaluationErrorCode, EvaluationReason } from '../model/result.js';
import type { EvaluationResult } from '../model/result.js';
import { isAllocated, settledAllocation } from './bucketing.js';
import { matchesConditions } from './conditions.js';
import type { SegmentMap } from './conditions.js';
import { bucketingKeyFor, pickVariant } from './rollout.js';
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
 *
 * Built on the first flag that actually declares a prerequisite, and passed as
 * `undefined` until then: most flags have no dependencies at all, and a Set and
 * a Map allocated per lookup would be pure waste on the request path.
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
    return evaluateGuarded(flag, context, environment);
  } catch (error) {
    // The no-throw contract has to hold for definitions that never went through
    // the parser too. A shape it would have rejected degrades to an ERROR
    // result rather than taking down the handler that hand-built it.
    const detail = error instanceof Error ? error.message : String(error);
    return invalidDefinition(flag, `Flag "${flag.key}" is not a usable definition: ${detail}`);
  }
}

/**
 * The pipeline body; `walk` carries the prerequisite chain and its memo, and is
 * `undefined` until some flag on the chain declares a prerequisite.
 */
function evaluateGuarded<T extends FlagValue>(
  flag: FlagDefinition<T>,
  context: EvaluationContext,
  environment: EvaluationEnvironment,
  walk?: PrerequisiteWalk,
): EvaluationResult<T> {
  if (!flag.enabled) return resolve(flag, flag.offVariant, EvaluationReason.Disabled);

  const gate = checkPrerequisites(flag, context, environment, walk);
  if (gate !== undefined) return gate;

  const targeted = matchTarget(flag, context.targetingKey, environment.targetIndex);
  if (targeted !== undefined) return resolve(flag, targeted, EvaluationReason.TargetingMatch);

  const salt = flag.salt ?? flag.key;

  const gated = checkAllocation(flag, context, salt);
  if (gated !== undefined) return gated;

  const ruled = matchRule(flag, context, environment, salt);
  if (ruled !== undefined) return ruled;

  if (flag.rollout !== undefined) {
    const picked = pickVariant(flag.rollout, context, salt);
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
 * The traffic-allocation gate. Returns the result to serve when the subject is
 * outside the exposed slice or cannot be bucketed at all, `undefined` when it
 * is admitted and evaluation should carry on.
 *
 * An identity is resolved only if the gate actually hashes one. A fully open or
 * fully closed allocation is decided by its percentage alone, and demanding a
 * key regardless would make finishing an experiment at 100 — or parking one at
 * 0 — answer TARGETING_KEY_MISSING for every anonymous or service context, on
 * rules that never needed bucketing.
 */
function checkAllocation<T extends FlagValue>(
  flag: FlagDefinition<T>,
  context: EvaluationContext,
  salt: string,
): EvaluationResult<T> | undefined {
  const allocation = flag.allocation;
  if (allocation === undefined) return undefined;

  const settled = settledAllocation(allocation);
  if (settled === true) return undefined;
  if (settled === false) return resolve(flag, flag.defaultVariant, EvaluationReason.NotAllocated);

  // The same identity rule as every split: a present, non-empty key.
  const { bucketBy } = allocation;
  const key = bucketingKeyFor(bucketBy, context);
  if (key === undefined) return bucketingKeyMissing(flag, bucketBy ?? 'targetingKey');

  if (isAllocated(allocation, salt, key)) return undefined;
  return resolve(flag, flag.defaultVariant, EvaluationReason.NotAllocated);
}

/**
 * The outcome of the first rule whose conditions all match, or `undefined` when
 * none did.
 *
 * The first match is final. A matched rule whose rollout carries no weight — a
 * parked experiment — serves the flag's default variant; letting it fall
 * through would silently promote the next rule to production the moment an
 * experiment is paused.
 *
 * A rule that declares both a rollout and a fixed variant is decided by the
 * rollout, parked or not, for the same reason: pausing an experiment must not
 * ship the fixed variant to everyone the rule matches.
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
      const picked = pickVariant(rule.rollout, context, salt, rule.id);
      if (picked.missingAttribute !== undefined) {
        return bucketingKeyMissing(flag, picked.missingAttribute, rule.id);
      }
      return picked.variant === undefined
        ? resolve(flag, flag.defaultVariant, EvaluationReason.Static, rule.id)
        : resolve(flag, picked.variant, EvaluationReason.Split, rule.id);
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
  walk: PrerequisiteWalk | undefined,
): EvaluationResult<T> | undefined {
  const prerequisites = flag.prerequisites;
  if (prerequisites === undefined || prerequisites.length === 0) return undefined;

  // The root of the walk: its own key has to be on the chain, or a hand-built
  // flag naming itself would recurse instead of being reported as a cycle.
  const chain: PrerequisiteWalk = walk ?? { visiting: new Set([flag.key]), memo: new Map() };

  if (chain.visiting.size > MAX_PREREQUISITE_DEPTH) {
    return invalidDefinition(
      flag,
      `Flag "${flag.key}" sits more than ${MAX_PREREQUISITE_DEPTH} prerequisites deep`,
    );
  }

  for (const prerequisite of prerequisites) {
    if (chain.visiting.has(prerequisite.flag)) {
      return invalidDefinition(
        flag,
        `Flag "${flag.key}" has a prerequisite cycle through "${prerequisite.flag}"`,
      );
    }

    const dependency = environment.flags?.get(prerequisite.flag);
    if (dependency === undefined) return prerequisiteFailed(flag, prerequisite);

    const outcome = evaluateDependency(dependency, context, environment, chain);

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
      isGatedOff(outcome.reason) ||
      !prerequisite.variants.includes(outcome.variant)
    ) {
      return prerequisiteFailed(flag, prerequisite);
    }
  }

  return undefined;
}

/**
 * Whether a dependency is serving what it serves because it was gated off,
 * rather than because targeting chose it.
 *
 * A closed gate upstream has to close everything under it. Without this, a
 * prerequisite that lists the dependency's off variant — a reasonable thing to
 * write — would be satisfied by a dependency that is itself switched off, and
 * whether it was switched off by `enabled: false` or by its own failed
 * prerequisite would decide the answer, for the very same served variant.
 */
function isGatedOff(reason: EvaluationReason): boolean {
  return reason === EvaluationReason.Disabled || reason === EvaluationReason.PrerequisiteFailed;
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
