import type { TargetingRule } from '@kurenwimpel/core';

import { pairByKey, sameJson } from './compare.js';
import { diffRollout } from './rollout-diff.js';
import { change } from './types.js';
import type { Change } from './types.js';

/**
 * Rules are matched by id. The first matching rule wins, so a reorder changes
 * who reaches which rule even when no rule changed. A renamed rule reads as one
 * removed and one added, which is also what it does to traffic: the rule id is
 * part of its split's hash domain.
 */
export function diffRules(
  before: readonly TargetingRule[],
  after: readonly TargetingRule[],
): Change[] {
  const oldIds = before.map((rule) => rule.id);
  const newIds = after.map((rule) => rule.id);
  const added = newIds.filter((id) => !oldIds.includes(id));
  const removed = oldIds.filter((id) => !newIds.includes(id));

  const changes: Change[] = [];
  if (added.length > 0) {
    changes.push(
      change({
        kind: 'rules-added',
        at: 'rules',
        added: added.length,
        to: added,
        summary: `rules added: ${added.join(', ')}; they take subjects from every rule below them`,
      }),
    );
  }
  if (removed.length > 0) {
    changes.push(
      change({
        kind: 'rules-removed',
        at: 'rules',
        removed: removed.length,
        from: removed,
        summary: `rules removed: ${removed.join(', ')}; their subjects fall through to the next match`,
      }),
    );
  }

  changes.push(...reorder(oldIds, newIds));

  for (const pair of pairByKey(before, after, (rule) => rule.id)) {
    if (pair.before !== undefined && pair.after !== undefined) {
      changes.push(...diffRule(pair.before, pair.after));
    }
  }
  return changes;
}

function reorder(oldIds: readonly string[], newIds: readonly string[]): Change[] {
  const kept = new Set(oldIds.filter((id) => newIds.includes(id)));
  const from = oldIds.filter((id) => kept.has(id));
  const to = newIds.filter((id) => kept.has(id));
  if (sameJson(from, to)) return [];

  return [
    change({
      kind: 'rules-reordered',
      at: 'rules',
      from,
      to,
      summary: `rules reordered from ${from.join(', ')} to ${to.join(', ')}: first match wins, so subjects matching several rules move`,
    }),
  ];
}

function diffRule(before: TargetingRule, after: TargetingRule): Change[] {
  const at = `rules[${after.id}]`;
  const fields = (['conditions', 'variant'] as const).filter(
    (field) => !sameJson(before[field], after[field]),
  );

  const changes: Change[] = [];
  if (fields.length > 0) {
    changes.push(
      change({
        kind: 'rule-changed',
        at,
        summary: `rule ${after.id}: ${fields.join(' and ')} changed`,
      }),
    );
  }
  changes.push(...diffRollout(`${at}.rollout`, before.rollout, after.rollout));
  return changes;
}
