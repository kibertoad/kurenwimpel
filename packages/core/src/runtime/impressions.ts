/**
 * Per-call helpers for the client: the context a call evaluates against, and
 * the impression that describes it.
 */

import { readTargetingKey } from '../evaluation/conditions.js';
import type { AttributeValue, EvaluationContext } from '../model/context.js';
import type { FlagDefinition, FlagMetadata } from '../model/flag.js';
import type { FlagValue } from '../model/json.js';
import type { EvaluationErrorCode, EvaluationReason, EvaluationResult } from '../model/result.js';

/**
 * One evaluation, described for analytics: the exposure record an A/B test
 * joins against its outcome metric. Emitted synchronously through
 * `onImpression`. `createImpressionBatcher` batches and deduplicates
 * the feed; shipping it is the consumer's job.
 */
export interface ImpressionEvent {
  readonly flagKey: string;
  readonly value: FlagValue | undefined;
  readonly variant: string | undefined;
  readonly reason: EvaluationReason;
  readonly ruleId?: string;
  readonly errorCode?: EvaluationErrorCode;
  readonly targetingKey?: string;
  /** The flag definition version, when the control plane stamps one. */
  readonly flagVersion?: number;
  readonly metadata?: FlagMetadata;
  /** Epoch millis when the evaluation happened. */
  readonly timestamp: number;
}

/**
 * The definition is handed over by the caller rather than looked up here:
 * every call site has just resolved it, and `evaluateAll` is already
 * iterating the definitions it would otherwise re-probe the map for, once per
 * flag in the ruleset.
 */
export function impressionOf(
  result: EvaluationResult,
  context: EvaluationContext,
  flag: FlagDefinition | undefined,
): ImpressionEvent {
  const flagVersion = flag?.version;
  // Resolved through the one identity rule rather than read off the context,
  // so the feed reports the key targeting actually used. Reading it directly
  // put whatever the caller passed on the event: a number in a field typed
  // string, breaking any downstream join on subject id; an empty string
  // alongside TARGETING_KEY_MISSING, counting an exposure for a subject that
  // was never bucketed; and, on a call with no per-call context, one
  // inherited from the default context's prototype and invisible to
  // targeting itself.
  const targetingKey = readTargetingKey(context);

  return {
    flagKey: result.key,
    value: result.value,
    variant: result.variant,
    reason: result.reason,
    ...(result.ruleId === undefined ? {} : { ruleId: result.ruleId }),
    ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
    ...(targetingKey === undefined ? {} : { targetingKey }),
    ...(flagVersion === undefined ? {} : { flagVersion }),
    ...(result.metadata === undefined ? {} : { metadata: result.metadata }),
    timestamp: Date.now(),
  };
}

/**
 * The context an evaluation actually runs against: the defaults, with
 * whatever the call said about them applied over the top.
 *
 * An explicit `null` reads as "no per-call context", exactly as omitting one
 * does. A JavaScript caller can pass it, the getters are documented never to
 * throw, and `evaluateFlag` already absorbs the same mistake one layer down.
 */
export function mergeContext(
  defaults: EvaluationContext,
  defaultEntries: readonly (readonly [string, AttributeValue | undefined])[],
  context: EvaluationContext | null | undefined,
): EvaluationContext {
  if (context === undefined || context === null) return defaults;

  // Null prototype: an own `__proto__` key in a JSON-parsed context must
  // land as plain data, never reach the Object.prototype setter and inject
  // inherited attributes into targeting.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const merged = Object.create(null) as Record<string, AttributeValue | undefined>;

  for (const [attribute, value] of defaultEntries) {
    merged[attribute] = value;
  }

  // A default survives only where the call said nothing about the attribute.
  // Naming it with an explicit `undefined` is how a caller says "this request
  // has no stage", which it otherwise has no way to express, so one walk of
  // one list drives both the clearing and the overwriting. Deciding which
  // defaults to skip with `Object.hasOwn` while copying the values with
  // `Object.entries` let the two disagree: a non-enumerable own attribute (an
  // accessor on a class instance, a proxy-backed request object) suppressed
  // the default without supplying anything in its place, and targeting saw
  // neither.
  for (const [attribute, value] of Object.entries(context)) {
    if (value === undefined) delete merged[attribute];
    else merged[attribute] = value;
  }

  return merged;
}
