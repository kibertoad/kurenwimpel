/**
 * Resolving a weighted split to a variant.
 *
 * Split resolution is the half of evaluation that has to hash something. It
 * lives apart from the pipeline so the order of the decision steps stays
 * readable on its own, and so the two things a draw needs — an identity and
 * some weight to distribute — are checked in one place.
 */

import type { EvaluationContext } from '../model/context.js';
import type { Rollout, RolloutBucket, RolloutSplit } from '../model/flag.js';
import { BUCKET_COUNT, bucketOf } from './bucketing.js';
import { readAttribute } from './conditions.js';

export interface PickOutcome {
  readonly variant?: string;
  /** Set when the attribute the split buckets on is absent from the context. */
  readonly missingAttribute?: string;
}

/**
 * Resolves a split — either wire form — to a variant name.
 *
 * `ruleId` is what separates one rule's draw from another's on the same flag
 * (ADR 0002); its absence means this is the flag's own rollout.
 */
export function pickVariant(
  rollout: Rollout,
  context: EvaluationContext,
  salt: string,
  ruleId?: string,
): PickOutcome {
  const split = isSplitObject(rollout) ? rollout : { buckets: rollout };
  if (!Array.isArray(split.buckets) || split.buckets.length === 0) return {};

  // Asked before an identity is: a split carrying no weight — a parked
  // experiment — resolves to nothing whoever the subject is, so demanding a
  // bucketing key first would turn pausing an experiment into
  // TARGETING_KEY_MISSING for every context that has none.
  const total = usableWeight(split.buckets);
  if (total === undefined) return {};

  const key = bucketingKeyFor(split.bucketBy, context);
  if (key === undefined) return { missingAttribute: split.bucketBy ?? 'targetingKey' };

  // Built here rather than by the caller, so a parked or unbucketable split
  // costs no allocation at all.
  const domain = ruleId === undefined ? ['rollout', salt] : ['rule', salt, ruleId];
  if (split.seed !== undefined) domain.push(split.seed);

  const variant = pickWeighted(split.buckets, domain, key, total);
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
export function bucketingKeyFor(
  bucketBy: string | undefined,
  context: EvaluationContext,
): string | undefined {
  // Read through `readAttribute` whichever attribute it is: the identity a
  // split hashes must not be the one attribute resolved off the prototype
  // chain. See {@link readTargetingKey}.
  const raw = readAttribute(context, bucketBy ?? 'targetingKey');
  if (typeof raw === 'string' && raw.length > 0) return raw;
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  return undefined;
}

/**
 * The weight a split actually distributes, or `undefined` when it distributes
 * none: all weights at zero — a parked experiment — or a total that overflows
 * to Infinity, which would send every subject to the last bucket.
 */
function usableWeight(buckets: readonly RolloutBucket[]): number | undefined {
  let total = 0;
  for (const bucket of buckets) {
    if (bucket.weight > 0) total += bucket.weight;
  }
  return total > 0 && Number.isFinite(total) ? total : undefined;
}

/** The bucket `bucketingKey` lands in, given a split known to carry `total` weight. */
function pickWeighted(
  buckets: readonly RolloutBucket[],
  domain: readonly string[],
  bucketingKey: string,
  total: number,
): string | undefined {
  const point = (bucketOf(domain, bucketingKey) / BUCKET_COUNT) * total;

  let cumulative = 0;
  let last: string | undefined;

  for (const bucket of buckets) {
    if (bucket.weight <= 0) continue;
    cumulative += bucket.weight;
    if (point < cumulative) return bucket.variant;
    last = bucket.variant;
  }

  // Only reachable through floating-point drift at the very top of the range.
  // The fallback has to respect the same weight filter the loop just applied:
  // the last bucket outright may be one parked at zero, and serving a variant
  // an operator set to zero weight is the one thing they asked not to happen.
  return last;
}
