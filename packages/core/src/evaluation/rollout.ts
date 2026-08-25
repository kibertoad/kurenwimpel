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
import { identityOf, readAttribute } from './conditions.js';

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
  // chain. See {@link readTargetingKey}. And resolved through `identityOf`,
  // so what counts as an identity here is what counts as one everywhere else.
  return identityOf(readAttribute(context, bucketBy ?? 'targetingKey'));
}

/**
 * Whether a bucket carries weight the split should distribute.
 *
 * Written as "not greater than zero" rather than "less than or equal to zero"
 * so that a weight of NaN — which a hand-built definition can carry, the
 * parser rejecting every non-finite one — is excluded rather than counted.
 * {@link usableWeight} and {@link pickWeighted} must agree on this exactly: a
 * bucket the total skipped but the walk did not poisoned `cumulative` from
 * that bucket onward, so every later `point < cumulative` test answered false
 * and the whole split silently skewed to its last usable bucket.
 */
function carriesWeight(bucket: RolloutBucket): boolean {
  return bucket.weight > 0;
}

/**
 * The weight a split actually distributes, or `undefined` when it distributes
 * none: all weights at zero — a parked experiment — or a total that overflows
 * to Infinity, which would send every subject to the last bucket.
 */
function usableWeight(buckets: readonly RolloutBucket[]): number | undefined {
  let total = 0;
  for (const bucket of buckets) {
    if (carriesWeight(bucket)) total += bucket.weight;
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
    if (!carriesWeight(bucket)) continue;
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
