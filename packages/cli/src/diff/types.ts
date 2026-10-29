/**
 * What one change does to live traffic. The README of this package describes
 * each kind; a consumer should treat an unknown kind as "changed, effect unknown".
 */
export type ChangeKind =
  | 'kill-switch'
  | 'allocation-widened'
  | 'allocation-narrowed'
  | 'rollout-shifted'
  | 'rollout-reshuffled'
  | 'rollout-added'
  | 'rollout-removed'
  | 'bucketing-changed'
  | 'rules-added'
  | 'rules-removed'
  | 'rules-reordered'
  | 'rule-changed'
  | 'targets-changed'
  | 'variants-changed'
  | 'default-variant-changed'
  | 'off-variant-changed'
  | 'prerequisites-changed'
  | 'metadata-changed'
  | 'included-changed'
  | 'excluded-changed'
  | 'segment-rules-changed';

export interface Change {
  readonly kind: ChangeKind;
  /** Where in the definition the change sits, e.g. `allocation` or `rules[recent-app].rollout`. */
  readonly at: string;
  /** True when the change reassigns subjects across the whole population. */
  readonly reshuffles: boolean;
  /** One line for a human reader. */
  readonly summary: string;
  /** The old and new value, as JSON. Absent when the field was unset on that side. */
  readonly from?: unknown;
  readonly to?: unknown;
  /** Keys, ids or variants added, as a count. */
  readonly added?: number;
  readonly removed?: number;
  readonly changed?: number;
}

export type EntryStatus = 'added' | 'removed' | 'changed';

export interface FlagDiff {
  readonly key: string;
  readonly status: EntryStatus;
  /** Empty for an added or removed flag. */
  readonly changes: readonly Change[];
}

export interface SegmentDiff extends FlagDiff {
  /** Flags in either ruleset whose conditions name this segment. */
  readonly referencedBy: readonly string[];
}

export interface RulesetDiff {
  readonly flags: readonly FlagDiff[];
  readonly segments: readonly SegmentDiff[];
  /** True when any change reshuffles subjects. */
  readonly reshuffles: boolean;
}

export function change(fields: Omit<Change, 'reshuffles'> & { reshuffles?: boolean }): Change {
  return { ...fields, reshuffles: fields.reshuffles ?? false };
}
