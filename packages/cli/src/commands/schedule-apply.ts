import { ExitCode, formatOption, stringOption, UsageError } from '../command.js';
import type { CliIo, CommandArgs } from '../command.js';
import { plural } from '../format/words.js';
import { isRecord } from '../json.js';
import { toJson } from '../ruleset-file.js';
import { allIssues, scheduleReport } from '../schedule/report.js';
import { parseTimestamp, timeOf } from '../schedule/schedule-file.js';
import type { ScheduleEntry, ScheduleIssue } from '../schedule/schedule-file.js';
import { simulate } from '../schedule/simulate.js';
import { displayPath, loadEnvironmentSchedule } from './schedule-files.js';
import type { EnvironmentSchedule } from './schedule-files.js';

export interface ScheduleApplyReport {
  readonly environment: string;
  /** The time entries were due against, as ISO 8601. */
  readonly now: string;
  readonly status: 'applied' | 'nothing-due' | 'refused';
  /** The entries applied, in the order they took effect. Empty unless `applied`. */
  readonly applied: readonly ScheduleEntry[];
  /** Entries left in the schedule. */
  readonly pending: number;
  readonly issues: readonly ScheduleIssue[];
}

export async function applySchedule(args: CommandArgs, io: CliIo): Promise<ExitCode> {
  const format = formatOption(args, ['text', 'json']);
  const now = nowOf(args, io);
  const loaded = await loadEnvironmentSchedule(args, io);
  const { entries } = loaded.schedule;

  const due = entries.filter((entry) => timeOf(entry) <= now.getTime());
  const simulation = simulate(loaded.document, due);
  const schedulePath = displayPath(loaded.schedulePath);
  const issues = allIssues(
    scheduleReport(loaded.environment, schedulePath, loaded.schedule, simulation),
  );

  const report: ScheduleApplyReport = {
    environment: loaded.environment,
    now: now.toISOString(),
    status: issues.length > 0 ? 'refused' : due.length > 0 ? 'applied' : 'nothing-due',
    applied: [],
    pending: entries.length,
    issues,
  };

  if (report.status === 'refused') {
    for (const issue of issues) io.stderr(`${schedulePath}: ${issue.entry}: ${issue.message}\n`);
    io.stderr(
      `refusing to apply the schedule of ${loaded.environment}: ` +
        `${plural(issues.length, 'issue')}; nothing written\n`,
    );
    if (format === 'json') io.stdout(toJson(report));
    return ExitCode.Findings;
  }

  const applied = simulation.steps.map((step) => step.entry);
  if (applied.length > 0) await write(io, loaded, simulation.document, applied);

  const done = { ...report, applied, pending: entries.length - applied.length };
  io.stdout(format === 'json' ? toJson(done) : renderText(done));
  return ExitCode.Ok;
}

function nowOf(args: CommandArgs, io: CliIo): Date {
  const value = stringOption(args, 'now');
  if (value === undefined) return io.now();
  const time = parseTimestamp(value);
  if (time === undefined) {
    throw new UsageError(
      '--now must be a date and time with a UTC offset, such as 2026-11-03T09:00:00Z',
    );
  }
  return new Date(time);
}

/**
 * The ruleset goes first: if the schedule write fails after it, the next run
 * applies the same entries again, which sets the same fields to the same values.
 */
async function write(
  io: CliIo,
  loaded: EnvironmentSchedule,
  document: unknown,
  applied: readonly ScheduleEntry[],
): Promise<void> {
  const ids = new Set(applied.map((entry) => entry.id));
  const remaining = loaded.schedule.raw.filter(
    (item) => !isRecord(item) || typeof item['id'] !== 'string' || !ids.has(item['id']),
  );
  await io.writeFile(loaded.rulesetPath, toJson(document));
  await io.writeFile(loaded.schedulePath, toJson(remaining));
}

function renderText(report: ScheduleApplyReport): string {
  const pending = `${report.pending} ${report.pending === 1 ? 'entry' : 'entries'} pending`;
  if (report.applied.length === 0) {
    return `${report.environment}: nothing due at ${report.now}; ${pending}\n`;
  }
  const ids = report.applied.map((entry) => entry.id).join(', ');
  return `${report.environment}: applied ${ids}; ${pending}\n`;
}
