import { ExitCode, FORMAT_OPTION, formatOption, stringOption, UsageError } from '../command.js';
import type { CliIo, Command, CommandArgs } from '../command.js';
import {
  renderScheduleGithub,
  renderScheduleMarkdown,
  renderScheduleText,
} from '../format/schedule-format.js';
import { toJson } from '../ruleset-file.js';
import { scheduleReport } from '../schedule/report.js';
import type { ScheduleReport } from '../schedule/report.js';
import { simulate } from '../schedule/simulate.js';
import { CONFIG_OPTION, CONFIG_USAGE } from './environment.js';
import { applySchedule } from './schedule-apply.js';
import { displayPath, loadEnvironmentSchedule } from './schedule-files.js';

export const scheduleCommand: Command = {
  name: 'schedule',
  summary: 'Check the scheduled changes of an environment, or apply the ones that are due.',
  usage: [
    'Usage: kurenwimpel schedule validate <env> [--config <path>] [--format text|json|markdown|github]',
    '       kurenwimpel schedule apply <env> [--now <iso>] [--config <path>] [--format text|json]',
    '',
    "validate applies every entry of the environment's schedule to its ruleset, in time",
    'order, and exits 1 when an entry cannot be read or would introduce a parse issue.',
    'apply does the same for the entries due at --now (default: the current time), writes',
    'the ruleset, and removes those entries from the schedule. It writes nothing and',
    'exits 1 when any entry has an issue.',
    CONFIG_USAGE,
  ].join('\n'),
  options: { ...FORMAT_OPTION, ...CONFIG_OPTION, now: { type: 'string' } },
  run(args, io) {
    const [action, ...positionals] = args.positionals;
    const rest = { ...args, positionals };
    if (action === 'validate') return validateSchedule(rest, io);
    if (action === 'apply') return applySchedule(rest, io);
    throw new UsageError('expected validate or apply, then <env>');
  },
};

async function validateSchedule(args: CommandArgs, io: CliIo): Promise<ExitCode> {
  const format = formatOption(args, ['text', 'json', 'markdown', 'github']);
  if (stringOption(args, 'now') !== undefined) {
    throw new UsageError('--now is only accepted by schedule apply');
  }

  const loaded = await loadEnvironmentSchedule(args, io);
  const simulation = simulate(loaded.document, loaded.schedule.entries);
  const report = scheduleReport(
    loaded.environment,
    displayPath(loaded.schedulePath),
    loaded.schedule,
    simulation,
  );

  io.stdout(render(report, format, loaded.text));
  return report.valid ? ExitCode.Ok : ExitCode.Findings;
}

function render(
  report: ScheduleReport,
  format: 'text' | 'json' | 'markdown' | 'github',
  text: string,
): string {
  switch (format) {
    case 'json':
      return toJson(report);
    case 'markdown':
      return renderScheduleMarkdown(report);
    case 'github':
      return renderScheduleGithub(report, text);
    case 'text':
      return renderScheduleText(report);
  }
}
