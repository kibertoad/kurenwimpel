import { parseRuleset } from '@kurenwimpel/core';
import type { FlagParseIssue, ParseRulesetResult } from '@kurenwimpel/core';

import { diffRuleset } from '../diff/ruleset-diff.js';
import type { Change } from '../diff/types.js';
import { isRecord } from '../json.js';
import { inTimeOrder } from './schedule-file.js';
import type { ScheduleEntry } from './schedule-file.js';

export interface ScheduleStep {
  readonly entry: ScheduleEntry;
  /** What the entry does to its flag, in the terms `diff` uses. */
  readonly changes: readonly Change[];
  /** Parse issues the entry introduces. Ones the ruleset had before it are left out. */
  readonly issues: readonly FlagParseIssue[];
}

export interface Simulation {
  /** One step per entry, in the order they take effect. */
  readonly steps: readonly ScheduleStep[];
  /** The ruleset document once every entry is applied. */
  readonly document: unknown;
}

/**
 * Applies `entries` to a ruleset document in time order, parsing the result
 * after each one, since every intermediate state is served for a while.
 */
export function simulate(document: unknown, entries: readonly ScheduleEntry[]): Simulation {
  let current = document;
  let parsed = parseRuleset(document);
  const steps: ScheduleStep[] = [];

  for (const entry of inTimeOrder(entries)) {
    const next = patchDocument(current, entry.flag, entry.set);
    if (next === undefined) {
      const issue = { at: entry.flag, message: `flag ${entry.flag} is not in the ruleset` };
      steps.push({ entry, changes: [], issues: [issue] });
      continue;
    }

    const after = parseRuleset(next);
    steps.push({
      entry,
      changes: changesTo(entry.flag, parsed, after),
      issues: added(parsed, after),
    });
    current = next;
    parsed = after;
  }
  return { steps, document: current };
}

/**
 * The document with `set` merged over the top level of flag `key`, or
 * `undefined` when it has no such flag. Takes every shape `parseRuleset` does.
 */
export function patchDocument(
  document: unknown,
  key: string,
  set: Readonly<Record<string, unknown>>,
): unknown {
  if (isRecord(document) && ('flags' in document || 'segments' in document)) {
    const flags = patchFlags(document['flags'], key, set);
    return flags === undefined ? undefined : { ...document, flags };
  }
  return patchFlags(document, key, set);
}

function patchFlags(
  flags: unknown,
  key: string,
  set: Readonly<Record<string, unknown>>,
): unknown[] | Record<string, unknown> | undefined {
  if (Array.isArray(flags)) {
    const list: readonly unknown[] = flags;
    const index = list.findIndex((flag) => isRecord(flag) && flag['key'] === key);
    if (index === -1) return undefined;
    return list.with(index, merge(list[index], set));
  }
  if (isRecord(flags) && Object.hasOwn(flags, key) && isRecord(flags[key])) {
    return { ...flags, [key]: merge(flags[key], set) };
  }
  return undefined;
}

function merge(flag: unknown, set: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const merged = Object.entries({ ...(isRecord(flag) ? flag : {}), ...set });
  return Object.fromEntries(merged.filter(([name]) => set[name] !== null));
}

function changesTo(key: string, before: ParseRulesetResult, after: ParseRulesetResult): Change[] {
  const flag = diffRuleset(before, after).flags.find((entry) => entry.key === key);
  return flag === undefined ? [] : [...flag.changes];
}

function added(before: ParseRulesetResult, after: ParseRulesetResult): FlagParseIssue[] {
  return after.issues.filter(
    (issue) =>
      !before.issues.some((known) => known.at === issue.at && known.message === issue.message),
  );
}
