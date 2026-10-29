import type { FlagParseIssue } from '@kurenwimpel/core';

import type { Change } from '../diff/types.js';
import type { ParsedSchedule, ScheduleEntry, ScheduleIssue } from './schedule-file.js';
import type { Simulation } from './simulate.js';

export interface ScheduledChange extends ScheduleEntry {
  /** What the entry does to its flag, against the ruleset as the entries before it leave it. */
  readonly changes: readonly Change[];
  /** Parse issues the entry would introduce. */
  readonly issues: readonly FlagParseIssue[];
}

export interface ScheduleReport {
  readonly environment: string;
  readonly schedule: string;
  /** False when an entry cannot be read or would introduce a parse issue. */
  readonly valid: boolean;
  /** Entries, or the file, that could not be read. */
  readonly issues: readonly ScheduleIssue[];
  /** The readable entries, in the order they take effect. */
  readonly entries: readonly ScheduledChange[];
}

export function scheduleReport(
  environment: string,
  path: string,
  schedule: ParsedSchedule,
  simulation: Simulation,
): ScheduleReport {
  const entries = simulation.steps.map((step): ScheduledChange => ({
    ...step.entry,
    changes: step.changes,
    issues: step.issues,
  }));
  return {
    environment,
    schedule: path,
    valid: schedule.issues.length === 0 && entries.every((entry) => entry.issues.length === 0),
    issues: schedule.issues,
    entries,
  };
}

/** Every issue of a report, each attributed to its entry. */
export function allIssues(report: ScheduleReport): ScheduleIssue[] {
  return [
    ...report.issues,
    ...report.entries.flatMap((entry) =>
      entry.issues.map((issue) => ({ entry: entry.id, message: `${issue.at}: ${issue.message}` })),
    ),
  ];
}
