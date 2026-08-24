/**
 * Evaluation outcomes: reasons, error codes, and the result shape.
 *
 * The reason vocabulary is a superset of the OFREP wire reasons — every value
 * that OFREP can name is spelled identically here, and the two extra ones
 * (`NOT_ALLOCATED`, `PREREQUISITE_FAILED`) have a defined wire mapping in
 * `model/ofrep.ts`.
 */

import type { FlagMetadata } from './flag.js';
import type { FlagValue } from './json.js';

export const EvaluationReason = {
  /** Flag is off; the off variant was served. */
  Disabled: 'DISABLED',
  /** A prerequisite flag was not serving a required variant; the off variant was served. */
  PrerequisiteFailed: 'PREREQUISITE_FAILED',
  /** An individual target or a targeting rule matched and served a fixed variant. */
  TargetingMatch: 'TARGETING_MATCH',
  /** The subject fell outside the flag's traffic allocation; the default variant was served. */
  NotAllocated: 'NOT_ALLOCATED',
  /** A percentage rollout selected the variant. */
  Split: 'SPLIT',
  /** Nothing matched; the statically configured default variant was served. */
  Static: 'STATIC',
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
  /** The rule that decided the outcome, when one did. */
  readonly ruleId?: string;
  /** The prerequisite flag that failed, when `reason` is `PREREQUISITE_FAILED`. */
  readonly failedPrerequisite?: string;
  /** The flag's annotations, passed through for exposure logging and the OFREP `metadata` field. */
  readonly metadata?: FlagMetadata;
  readonly errorCode?: EvaluationErrorCode;
  readonly errorMessage?: string;
}
