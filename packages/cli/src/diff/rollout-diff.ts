import type { Rollout, RolloutBucket, RolloutSplit, TrafficAllocation } from '@kurenwimpel/core';

import { inline } from '../format/words.js';
import { sameJson } from './compare.js';
import { change } from './types.js';
import type { Change } from './types.js';

function isSplit(rollout: Rollout): rollout is RolloutSplit {
  return !Array.isArray(rollout);
}

function toSplit(rollout: Rollout): RolloutSplit {
  return isSplit(rollout) ? rollout : { buckets: rollout };
}

/** The buckets that carry weight: a zero-weight bucket moves no boundary. */
function weighted(split: RolloutSplit): RolloutBucket[] {
  return split.buckets
    .filter((bucket) => bucket.weight > 0)
    .map(({ variant, weight }) => ({ variant, weight }));
}

function total(buckets: readonly RolloutBucket[]): number {
  return buckets.reduce((sum, bucket) => sum + bucket.weight, 0);
}

function describeWeights(buckets: readonly RolloutBucket[]): string {
  return buckets.length === 0
    ? 'no weight'
    : buckets.map((bucket) => `${bucket.variant} ${bucket.weight}`).join(' / ');
}

/**
 * Classifies a change to one split. Assignment is normalised by the total
 * weight, so the total decides whether a reweighting only moves the subjects
 * at the boundaries that moved or rescales every boundary at once.
 */
export function diffRollout(at: string, before?: Rollout, after?: Rollout): Change[] {
  if (before === undefined && after === undefined) return [];

  if (before === undefined || after === undefined) {
    const present = toSplit((before ?? after)!);
    const weights = describeWeights(weighted(present));
    return [
      before === undefined
        ? change({ kind: 'rollout-added', at, to: weights, summary: `split added: ${weights}` })
        : change({
            kind: 'rollout-removed',
            at,
            from: weights,
            summary: `split removed: ${weights}`,
          }),
    ];
  }

  const old = toSplit(before);
  const next = toSplit(after);
  return [
    ...bucketingChange(`${at}.bucketBy`, old.bucketBy, next.bucketBy),
    ...bucketingChange(`${at}.seed`, old.seed, next.seed),
    ...weightChange(at, weighted(old), weighted(next)),
  ];
}

function weightChange(
  at: string,
  old: readonly RolloutBucket[],
  next: readonly RolloutBucket[],
): Change[] {
  if (sameJson(old, next)) return [];

  const from = describeWeights(old);
  const to = describeWeights(next);
  const oldTotal = total(old);
  const newTotal = total(next);

  if (oldTotal === newTotal) {
    return [
      change({
        kind: 'rollout-shifted',
        at,
        from,
        to,
        summary: `weights ${from} to ${to}, same total: only subjects at the moved boundaries change variant`,
      }),
    ];
  }

  return [
    change({
      kind: 'rollout-reshuffled',
      at,
      from,
      to,
      reshuffles: true,
      summary: `weights ${from} to ${to}, total ${oldTotal} to ${newTotal}: every boundary moves, reshuffles everyone`,
    }),
  ];
}

/** A changed `seed`, `bucketBy` or salt draws every subject afresh. */
export function bucketingChange(at: string, before?: string, after?: string): Change[] {
  if (before === after) return [];
  return [
    change({
      kind: 'bucketing-changed',
      at,
      ...(before === undefined ? {} : { from: before }),
      ...(after === undefined ? {} : { to: after }),
      reshuffles: true,
      summary: `${at} ${inline(before)} to ${inline(after)}: reshuffles everyone`,
    }),
  ];
}

/** An absent allocation admits everyone. */
export function diffAllocation(before?: TrafficAllocation, after?: TrafficAllocation): Change[] {
  const changes = [
    ...bucketingChange('allocation.bucketBy', before?.bucketBy, after?.bucketBy),
    ...bucketingChange('allocation.seed', before?.seed, after?.seed),
  ];

  const from = before?.percent ?? 100;
  const to = after?.percent ?? 100;
  if (from === to) return changes;

  const widened = to > from;
  changes.unshift(
    change({
      kind: widened ? 'allocation-widened' : 'allocation-narrowed',
      at: 'allocation.percent',
      from,
      to,
      summary: widened
        ? `allocation ${from}% to ${to}%: only adds subjects, nobody admitted is reassigned`
        : `allocation ${from}% to ${to}%: removes subjects, who fall back to the default variant`,
    }),
  );
  return changes;
}
