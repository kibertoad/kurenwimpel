/**
 * Domain types for flag definitions and evaluation.
 *
 * Everything here is plain data: definitions are expected to arrive as JSON from
 * whatever control plane a service wrapper talks to, so nothing in this module
 * may reference a platform API.
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** The value a variant resolves to. */
export type FlagValue = JsonValue;

/** Attribute values a caller may put on an evaluation context. */
export type AttributeValue = string | number | boolean | readonly string[] | readonly number[];

/**
 * Who (or what) a flag is being evaluated for.
 *
 * `targetingKey` is the stable identity used for percentage rollouts — a user
 * id, account id, or device id. Without it, a rollout cannot be bucketed
 * deterministically and evaluation falls back to the default variant.
 */
export interface EvaluationContext {
  readonly targetingKey?: string;
  readonly attributes?: Readonly<Record<string, AttributeValue>>;
}

/**
 * A single targeting predicate. `attribute` is looked up on
 * {@link EvaluationContext.attributes}, except for the reserved name
 * `targetingKey`, which reads the context's targeting key.
 */
export type Condition =
  | { readonly attribute: string; readonly operator: 'exists' | 'notExists' }
  | {
      readonly attribute: string;
      readonly operator: 'eq' | 'neq';
      readonly value: string | number | boolean;
    }
  | {
      readonly attribute: string;
      readonly operator: 'in' | 'notIn';
      readonly value: readonly (string | number)[];
    }
  | {
      readonly attribute: string;
      readonly operator: 'contains' | 'startsWith' | 'endsWith';
      readonly value: string;
    }
  | {
      readonly attribute: string;
      readonly operator: 'gt' | 'gte' | 'lt' | 'lte';
      readonly value: number;
    };

export type ConditionOperator = Condition['operator'];

/** One slice of a percentage split. Weights are relative and normalised by their sum. */
export interface RolloutBucket {
  readonly variant: string;
  readonly weight: number;
}

/**
 * A targeting rule. All conditions must match (logical AND). A matching rule
 * serves either a fixed `variant` or a percentage `rollout`; if it declares
 * both, the rollout wins.
 */
export interface TargetingRule {
  readonly id: string;
  readonly conditions: readonly Condition[];
  readonly variant?: string;
  readonly rollout?: readonly RolloutBucket[];
}

/**
 * A flag as stored in the control plane.
 *
 * `variants` maps a variant name to the value served for it. `defaultVariant`
 * is served when the flag is on and no rule matched; `offVariant` is served
 * when `enabled` is false — the kill switch.
 */
export interface FlagDefinition<T extends FlagValue = FlagValue> {
  readonly key: string;
  readonly enabled: boolean;
  readonly variants: Readonly<Record<string, T>>;
  readonly defaultVariant: string;
  readonly offVariant: string;
  readonly rules?: readonly TargetingRule[];
  readonly rollout?: readonly RolloutBucket[];
  /** Bucketing salt. Defaults to `key`. Change it to reshuffle a rollout. */
  readonly salt?: string;
  readonly version?: number;
}

export const EvaluationReason = {
  /** Flag is off; the off variant was served. */
  Disabled: 'DISABLED',
  /** A targeting rule matched and served a fixed variant. */
  TargetingMatch: 'TARGETING_MATCH',
  /** A percentage rollout selected the variant. */
  Split: 'SPLIT',
  /** No rule matched; the default variant was served. */
  Default: 'DEFAULT',
  /** Evaluation failed; see `errorCode`. */
  Error: 'ERROR',
} as const;

export type EvaluationReason = (typeof EvaluationReason)[keyof typeof EvaluationReason];

export const EvaluationErrorCode = {
  FlagNotFound: 'FLAG_NOT_FOUND',
  ProviderNotReady: 'PROVIDER_NOT_READY',
  TargetingKeyMissing: 'TARGETING_KEY_MISSING',
  VariantNotFound: 'VARIANT_NOT_FOUND',
  TypeMismatch: 'TYPE_MISMATCH',
  InvalidDefinition: 'INVALID_DEFINITION',
} as const;

export type EvaluationErrorCode = (typeof EvaluationErrorCode)[keyof typeof EvaluationErrorCode];

/**
 * The outcome of evaluating one flag.
 *
 * `value` is `undefined` only when the flag could not be resolved at all; the
 * client substitutes the caller's fallback in that case. An error code may be
 * present alongside a usable value — a missing targeting key, for instance,
 * still serves the default variant.
 */
export interface EvaluationResult<T extends FlagValue = FlagValue> {
  readonly key: string;
  readonly value: T | undefined;
  readonly variant: string | undefined;
  readonly reason: EvaluationReason;
  readonly ruleId?: string;
  readonly errorCode?: EvaluationErrorCode;
  readonly errorMessage?: string;
}
