/**
 * The flag definition — the unit a control plane stores and ships.
 *
 * Everything here is plain data, expected to arrive as JSON. Nothing in this
 * module may reference a platform API.
 */

import type { FlagValue } from './json.js';

/**
 * A single targeting predicate. `attribute` is looked up on the flat
 * {@link import('./context.js').EvaluationContext}; the name `targetingKey`
 * therefore reads the context's targeting key like any other attribute.
 *
 * The segment operators take no attribute: membership is a property of the
 * whole context (the targeting key against the segment's lists, the
 * attributes against its rules).
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
    }
  | {
      readonly attribute: string;
      readonly operator: 'semverEq' | 'semverGt' | 'semverGte' | 'semverLt' | 'semverLte';
      readonly value: string;
    }
  | { readonly operator: 'inSegment' | 'notInSegment'; readonly segments: readonly string[] };

export type ConditionOperator = Condition['operator'];

/** One slice of a percentage split. Weights are relative and normalised by their sum. */
export interface RolloutBucket {
  readonly variant: string;
  readonly weight: number;
}

/**
 * The full form of a percentage split.
 *
 * `bucketBy` hashes an attribute instead of the targeting key, so a cohort
 * flips together — bucket by `accountId` and every user of an account gets the
 * same variant. `seed` feeds the assignment hash: changing it re-randomises
 * who gets what without touching any other rollout of the flag, which is how
 * an experiment gets a fresh draw for its next iteration.
 */
export interface RolloutSplit {
  readonly buckets: readonly RolloutBucket[];
  readonly bucketBy?: string;
  readonly seed?: string;
}

/** A split is written either as a bare bucket list or as a {@link RolloutSplit}. */
export type Rollout = readonly RolloutBucket[] | RolloutSplit;

/**
 * Individual targeting: these keys always get this variant.
 *
 * Checked before traffic allocation and rules, so a QA account or a demo
 * tenant sees a treatment regardless of any percentage. Snapshots fold every
 * flag's targets into one key-to-variant map when they are built, so the list
 * costs one probe per evaluation however long it grows.
 */
export interface VariantTarget {
  readonly variant: string;
  readonly keys: readonly string[];
}

/**
 * Limits how much traffic enters the flag's rules and rollouts at all.
 *
 * A subject outside `percent` gets the default variant with reason
 * `NOT_ALLOCATED` — it never reaches the rules. The allocation hash is
 * deliberately decorrelated from variant assignment, so ramping 10% → 50%
 * admits new subjects without reshuffling the treatments of anyone already
 * inside. `seed` re-draws who is admitted.
 */
export interface TrafficAllocation {
  /** Share of traffic admitted, 0–100. Granularity is 0.01. */
  readonly percent: number;
  /**
   * The identity the gate hashes. Defaults to the targeting key — one identity
   * decides "is this subject in the experiment" — which admits an account's
   * users independently even when assignment then clusters them. Set it to the
   * split's `bucketBy` attribute to admit or exclude the whole cohort together.
   */
  readonly bucketBy?: string;
  readonly seed?: string;
}

/**
 * A dependency on another flag: it must be enabled and currently serving one
 * of `variants` for this flag to proceed. A failed prerequisite serves this
 * flag's `offVariant` — the dependency acts as a layered kill switch.
 */
export interface Prerequisite {
  readonly flag: string;
  readonly variants: readonly string[];
}

/**
 * A targeting rule. All conditions must match (logical AND); OR is expressed
 * as two rules. A matching rule serves either a fixed `variant` or a
 * percentage `rollout`; if it declares both, the rollout wins.
 */
export interface TargetingRule {
  readonly id: string;
  readonly conditions: readonly Condition[];
  readonly variant?: string;
  readonly rollout?: Rollout;
}

/**
 * Free-form annotations carried through to every evaluation result — an
 * experiment id, an owner, a ticket. Scalar-valued because that is what the
 * OFREP `metadata` field can carry.
 */
export type FlagMetadata = Readonly<Record<string, boolean | string | number>>;

/**
 * A flag as stored in the control plane.
 *
 * `variants` maps a variant name to the value served for it. `defaultVariant`
 * is served when the flag is on and nothing matched; `offVariant` is served
 * when `enabled` is false — the kill switch — and when a prerequisite fails.
 */
export interface FlagDefinition<T extends FlagValue = FlagValue> {
  readonly key: string;
  readonly enabled: boolean;
  readonly variants: Readonly<Record<string, T>>;
  readonly defaultVariant: string;
  readonly offVariant: string;
  readonly prerequisites?: readonly Prerequisite[];
  readonly targets?: readonly VariantTarget[];
  readonly allocation?: TrafficAllocation;
  readonly rules?: readonly TargetingRule[];
  readonly rollout?: Rollout;
  /** Bucketing salt. Defaults to `key`. Change it to reshuffle every split of the flag. */
  readonly salt?: string;
  readonly version?: number;
  readonly metadata?: FlagMetadata;
}
