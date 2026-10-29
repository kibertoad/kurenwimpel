import type { FlagDefinition, JsonValue, VariantTarget } from '@kurenwimpel/core';

import { inline, plural } from '../format/words.js';
import { sameJson, setDelta } from './compare.js';
import { bucketingChange, diffAllocation, diffRollout } from './rollout-diff.js';
import { diffRules } from './rules-diff.js';
import { change } from './types.js';
import type { Change } from './types.js';

/** Every change between two definitions of one flag, in the order the evaluator consults them. */
export function diffFlag(before: FlagDefinition, after: FlagDefinition): Change[] {
  return [
    ...killSwitch(before.enabled, after.enabled),
    ...diffVariants(before.variants, after.variants),
    ...valueChange('defaultVariant', before.defaultVariant, after.defaultVariant),
    ...valueChange('offVariant', before.offVariant, after.offVariant),
    ...valueChange('prerequisites', before.prerequisites, after.prerequisites),
    ...diffTargets(before.targets ?? [], after.targets ?? []),
    ...bucketingChange('salt', before.salt ?? before.key, after.salt ?? after.key),
    ...diffAllocation(before.allocation, after.allocation),
    ...diffRules(before.rules ?? [], after.rules ?? []),
    ...diffRollout('rollout', before.rollout, after.rollout),
    ...valueChange('metadata', before.metadata, after.metadata),
  ];
}

function killSwitch(before: boolean, after: boolean): Change[] {
  if (before === after) return [];
  return [
    change({
      kind: 'kill-switch',
      at: 'enabled',
      from: before,
      to: after,
      summary: after
        ? 'flag switched on: targeting decides again'
        : 'flag switched off: everyone gets offVariant',
    }),
  ];
}

const VALUE_KINDS = {
  defaultVariant: 'default-variant-changed',
  offVariant: 'off-variant-changed',
  prerequisites: 'prerequisites-changed',
  metadata: 'metadata-changed',
} as const;

function valueChange(field: keyof typeof VALUE_KINDS, before: unknown, after: unknown): Change[] {
  if (sameJson(before, after)) return [];
  return [
    change({
      kind: VALUE_KINDS[field],
      at: field,
      ...(before === undefined ? {} : { from: before }),
      ...(after === undefined ? {} : { to: after }),
      summary: `${field} ${inline(before)} to ${inline(after)}`,
    }),
  ];
}

function diffVariants(
  before: Readonly<Record<string, JsonValue>>,
  after: Readonly<Record<string, JsonValue>>,
): Change[] {
  const { added, removed } = setDelta(Object.keys(before), Object.keys(after));
  const changed = Object.keys(after).filter(
    (name) => Object.hasOwn(before, name) && !sameJson(before[name], after[name]),
  );
  if (added.length + removed.length + changed.length === 0) return [];

  const parts = [
    ...(added.length > 0 ? [`added ${added.join(', ')}`] : []),
    ...(removed.length > 0 ? [`removed ${removed.join(', ')}`] : []),
    ...(changed.length > 0 ? [`new value for ${changed.join(', ')}`] : []),
  ];
  return [
    change({
      kind: 'variants-changed',
      at: 'variants',
      added: added.length,
      removed: removed.length,
      changed: changed.length,
      summary: `variants: ${parts.join('; ')}`,
    }),
  ];
}

/** Individual targets, compared as a key-to-variant map. The first target listing a key wins. */
function diffTargets(before: readonly VariantTarget[], after: readonly VariantTarget[]): Change[] {
  const old = targetMap(before);
  const next = targetMap(after);
  const { added, removed } = setDelta(old.keys(), next.keys());
  const changed = [...next.keys()].filter((key) => old.has(key) && old.get(key) !== next.get(key));
  if (added.length + removed.length + changed.length === 0) return [];

  return [
    change({
      kind: 'targets-changed',
      at: 'targets',
      added: added.length,
      removed: removed.length,
      changed: changed.length,
      summary:
        `targets: ${plural(added.length, 'key')} added, ${removed.length} removed, ` +
        `${changed.length} moved to another variant`,
    }),
  ];
}

function targetMap(targets: readonly VariantTarget[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const target of targets) {
    for (const key of target.keys) if (!map.has(key)) map.set(key, target.variant);
  }
  return map;
}
