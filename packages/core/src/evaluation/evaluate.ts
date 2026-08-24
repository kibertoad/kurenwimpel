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
import { isKeyedDefinition } from '../parsing/primitives.js';
import { drawAllocation, settledAllocation } from './bucketing.js';
import { matchesConditions, readTargetingKey } from './conditions.js';
import type { SegmentMap } from './conditions.js';
import { bucketingKeyFor, pickVariant } from './rollout.js';
import { foldedTargets } from './targets.js';
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
 * Raised when a chain runs deeper than {@link MAX_PREREQUISITE_DEPTH}, and
 * caught by {@link evaluateFlag}, which reports it against the flag that was
 * actually asked for.
 *
 * Thrown rather than returned because depth is a property of the walk, not of
 * the flag it stops at: the very same flag is thirty prerequisites below one
 * root and fifty-one below another. A returned error would be memoised under
 * that flag's key and would then answer for it on every later lookup sharing
 * the memo — so which flags a bulk response called broken would come down to
 * the order the snapshot happens to iterate in, and one flag would answer
 * differently through `evaluate` than through `evaluateAll`. Unwinding to the
 * root instead leaves the memo holding only results that stand on their own.
 */
class PrerequisiteDepthError extends Error {
  override readonly name = 'PrerequisiteDepthError';

  constructor(deepest: string) {
    super(`prerequisite chain more than ${MAX_PREREQUISITE_DEPTH} deep, reaching "${deepest}"`);
  }
}

/**
 * A prerequisite memo shared by several flags evaluated against one context.
 *
 * Opaque on purpose: it is a cache keyed by flag, valid only for the context it
 * was filled against. Build one with {@link createSharedMemo} and discard it
 * with the request.
 */
export type SharedPrerequisiteMemo = Map<string, EvaluationResult>;

/** The flags on the chain being walked, and the memo they all share. */
interface PrerequisiteChain {
  /** Meeting one of these again is a cycle. */
  readonly visiting: ReadonlySet<string>;
  readonly memo: SharedPrerequisiteMemo;
}

/**
 * What an evaluation carries down its prerequisite chain: a bare memo until
 * some flag on the chain declares a prerequisite, a full chain from there on.
 *
 * The two shapes share one parameter so that starting a chain costs nothing
 * until there is one to start. Most flags declare no prerequisite at all, and
 * a bulk evaluation that seeded a Set per flag up front would allocate one for
 * every flag in the ruleset only for {@link checkPrerequisites} to return
 * before ever reading it.
 *
 * `memo` is what keeps the walk linear. Two flags that share a dependency must
 * cost one evaluation of it, not one per path that reaches it — otherwise a
 * chain of depth n costs 2^n, and a control plane can turn a single lookup into
 * seconds of CPU. Every entry was computed against the same context, which is
 * fixed for the whole walk.
 */
type PrerequisiteTrail = SharedPrerequisiteMemo | PrerequisiteChain;

/**
 * A memo to hand to every {@link evaluateFlag} call of one bulk evaluation.
 *
 * Each flag otherwise seeds a memo of its own, which keeps a single flag's
 * chain linear but does nothing across flags: a kill switch that gates 200 of
 * them is evaluated 200 times, and everything beneath it with it. Sharing the
 * memo makes a bulk response O(flags + edges) instead of O(flags × depth).
 *
 * Only the memo is shared. Every flag still gets its own `visiting` chain, or
 * one flag's ancestry would read as another flag's cycle.
 */
export function createSharedMemo(): SharedPrerequisiteMemo {
  return new Map();
}

/**
 * Evaluates one flag against a context. The entry point of the whole core.
 *
 * `memo` is for evaluating many flags against one context; see
 * {@link createSharedMemo}. A single lookup should omit it.
 */
export function evaluateFlag<T extends FlagValue = FlagValue>(
  flag: FlagDefinition<T>,
  context: EvaluationContext = {},
  environment: EvaluationEnvironment = {},
  memo?: SharedPrerequisiteMemo,
): EvaluationResult<T> {
  // Hand-built call sites reach the entry point too, so its arguments have to
  // survive being wrong. Checked ahead of the `try` rather than inside it: the
  // catch below names the flag in every error it reports, and something that
  // is not a definition has no name to report one under. Through the parser's
  // own predicate rather than a second copy of it — written out twice, the two
  // had already drifted over whether an array counts.
  if (!isKeyedDefinition(flag)) return unusableDefinition();

  try {
    return evaluateGuarded(flag, contextOf(context), environment, memo);
  } catch (error) {
    if (error instanceof PrerequisiteDepthError) {
      return invalidDefinition(flag, `Flag "${flag.key}" has a ${error.message}`);
    }

    // The no-throw contract has to hold for definitions that never went through
    // the parser too. A shape it would have rejected degrades to an ERROR
    // result rather than taking down the handler that hand-built it.
    const detail = error instanceof Error ? error.message : String(error);
    return invalidDefinition(flag, `Flag "${flag.key}" is not a usable definition: ${detail}`);
  }
}

/**
 * The context to evaluate against.
 *
 * A JavaScript caller can pass an explicit `null`, which slips past the
 * parameter default. That is the caller's mistake and not the definition's, so
 * it reads as "no attributes" rather than throwing out of the first
 * own-property probe and being reported as an unusable flag — which would send
 * whoever reads the error after entirely the wrong thing.
 */
function contextOf(context: EvaluationContext | null | undefined): EvaluationContext {
  return context ?? NO_CONTEXT;
}

const NO_CONTEXT: EvaluationContext = {};

/**
 * The pipeline body; `trail` carries the prerequisite memo, and the chain
 * walked so far once some flag has started one. See {@link PrerequisiteTrail}.
 */
function evaluateGuarded<T extends FlagValue>(
  flag: FlagDefinition<T>,
  context: EvaluationContext,
  environment: EvaluationEnvironment,
  trail: PrerequisiteTrail | undefined,
): EvaluationResult<T> {
  if (!flag.enabled) return resolve(flag, flag.offVariant, EvaluationReason.Disabled);

  const gate = checkPrerequisites(flag, context, environment, trail);
  if (gate !== undefined) return gate;

  const targeted = matchTarget(flag, readTargetingKey(context), environment.targetIndex);
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

  // `settledAllocation` is already answered above, so this draws directly
  // rather than going through `isAllocated` and asking it a second time.
  if (drawAllocation(allocation, salt, key)) return undefined;
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
  trail: PrerequisiteTrail | undefined,
): EvaluationResult<T> | undefined {
  const prerequisites = flag.prerequisites;
  if (prerequisites === undefined || prerequisites.length === 0) return undefined;

  const chain = chainFrom(flag.key, trail);

  if (chain.visiting.size > MAX_PREREQUISITE_DEPTH) throw new PrerequisiteDepthError(flag.key);

  for (const prerequisite of prerequisites) {
    if (chain.visiting.has(prerequisite.flag)) {
      return invalidDefinition(
        flag,
        `Flag "${flag.key}" has a prerequisite cycle through "${prerequisite.flag}"`,
      );
    }

    const dependency = environment.flags?.get(prerequisite.flag);
    if (dependency === undefined) return prerequisiteFailed(flag, prerequisite);

    const outcome = tryDependency(dependency, context, environment, chain);

    // A dependency that could not be evaluated at all is a dependency that does
    // not hold — the plainest case of the rule the next block states.
    if (outcome === undefined) return prerequisiteFailed(flag, prerequisite);

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

/**
 * The chain to walk from here: the one already in progress, or a fresh one
 * rooted at this flag.
 *
 * Built here rather than by the entry point, so a flag that declares no
 * prerequisite — the overwhelming majority of any ruleset — costs no
 * allocation at all, memo or no memo. The root's own key has to go on the
 * chain, or a hand-built flag naming itself would recurse instead of being
 * reported as a cycle.
 */
function chainFrom(key: string, trail: PrerequisiteTrail | undefined): PrerequisiteChain {
  if (trail !== undefined && !(trail instanceof Map)) return trail;
  return { visiting: new Set([key]), memo: trail ?? new Map() };
}

/**
 * One dependency, evaluated behind a guard of its own. `undefined` means it
 * could not be evaluated at all.
 *
 * A dependency that throws is the dependency's defect, and charging it to the
 * flag that merely names one is the wrong diagnosis in both directions.
 * Unguarded, the throw unwound past every dependent to {@link evaluateFlag},
 * which reported the flag the caller *asked* for as "not a usable definition"
 * — so one hand-built flag with a broken shape made every flag above it look
 * broken too, and each of them answered with no value at all, sending every
 * SDK to its own hardcoded default instead of to the off variant its gate
 * called for. ADR 0006 is explicit that a dependency erroring is a dependency
 * that does not hold: PREREQUISITE_FAILED, off variant, fail closed.
 *
 * The depth error is the one exception and is rethrown untouched. Depth is a
 * property of the walk rather than of the flag it stops at, so it is reported
 * against the flag that was actually asked for; see
 * {@link PrerequisiteDepthError}.
 *
 * Nothing is memoised for a throwing dependency — the memo holds evaluation
 * outcomes, and this is the absence of one. A dependency broken this way is
 * hand-built only (the parser cannot emit one) and re-throwing it per dependent
 * costs far less than a memo entry every other reader would have to interpret.
 */
function tryDependency(
  dependency: FlagDefinition,
  context: EvaluationContext,
  environment: EvaluationEnvironment,
  chain: PrerequisiteChain,
): EvaluationResult | undefined {
  try {
    return evaluateDependency(dependency, context, environment, chain);
  } catch (error) {
    if (error instanceof PrerequisiteDepthError) throw error;
    return undefined;
  }
}

/** One dependency, evaluated at most once per request. See {@link PrerequisiteTrail}. */
function evaluateDependency(
  dependency: FlagDefinition,
  context: EvaluationContext,
  environment: EvaluationEnvironment,
  chain: PrerequisiteChain,
): EvaluationResult {
  const cached = chain.memo.get(dependency.key);
  if (cached !== undefined) return cached;

  const outcome = evaluateGuarded(dependency, context, environment, {
    visiting: new Set([...chain.visiting, dependency.key]),
    memo: chain.memo,
  });

  chain.memo.set(dependency.key, outcome);
  return outcome;
}

/** The variant an individual target pins this key to, if any. */
function matchTarget(
  flag: FlagDefinition,
  targetingKey: string | undefined,
  index: TargetIndex | undefined,
): string | undefined {
  // Already resolved through {@link readTargetingKey}, which applies the one
  // identity rule the whole engine shares: an own property, and a usable one.
  if (targetingKey === undefined) return undefined;

  // A snapshot has folded every flag's targets into one lookup, so the request
  // path is a single probe however many keys are listed. A flag reaching here
  // without one — evaluated directly, outside a snapshot, or left out of the
  // index because it targets nobody — is folded through the memo rather than
  // scanned by a second copy of the same rules: which target claims a key, and
  // what a target whose `keys` is not a list matches, are decided in
  // `compileTargets` and nowhere else, and the fold is paid once either way.
  const compiled = index?.get(flag.key) ?? foldedTargets(flag);
  return compiled?.get(targetingKey);
}

/**
 * The result of serving one variant.
 *
 * The variant value and the metadata travel out by reference — copying either
 * per evaluation would put an allocation on the request path for every object
 * flag and every annotated one. What makes that safe is that the parser stores
 * frozen copies of both (see `cloneJson`), so a caller cannot write through
 * the result it was handed and change what the snapshot serves everyone after
 * it. A definition assembled by hand, without the parser, is the assembler's
 * own object and its own business.
 */
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

/**
 * The result for an argument that is not a flag definition at all.
 *
 * There is no key to report it under, because the caller handed over nothing
 * that carries one. An empty key beats the alternative: a TypeError thrown out
 * of the one function in the package documented never to throw.
 */
function unusableDefinition<T extends FlagValue>(): EvaluationResult<T> {
  return {
    key: '',
    value: undefined,
    variant: undefined,
    reason: EvaluationReason.Error,
    errorCode: EvaluationErrorCode.InvalidDefinition,
    errorMessage: 'Not a flag definition: expected an object with a string key',
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
