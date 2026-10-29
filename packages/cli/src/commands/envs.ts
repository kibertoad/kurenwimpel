import { booleanOption, ExitCode, FORMAT_OPTION, formatOption, UsageError } from '../command.js';
import type { Command } from '../command.js';
import { changedEnvironments, codeownersLines, listEnvironments } from '../config/environments.js';
import type { EnvironmentSummary } from '../config/environments.js';
import { toJson } from '../ruleset-file.js';
import { CONFIG_OPTION, CONFIG_USAGE, readConfig } from './environment.js';

export interface EnvsReport {
  readonly environments: readonly EnvironmentSummary[];
}

export const envsCommand: Command = {
  name: 'envs',
  summary: 'List the configured environments, or the ones a set of changed files touches.',
  usage: [
    'Usage: kurenwimpel envs [--changed <file...>] [--config <path>] [--format text|json|codeowners]',
    '',
    'With --changed, lists the environments whose ruleset is among the files, or every',
    'environment when the config itself is. No files lists none. Paths are relative to the',
    'working directory. --format codeowners prints one CODEOWNERS line per environment',
    'that names approvers.',
    CONFIG_USAGE,
  ].join('\n'),
  options: { ...FORMAT_OPTION, ...CONFIG_OPTION, changed: { type: 'boolean' } },
  async run(args, io) {
    const format = formatOption(args, ['text', 'json', 'codeowners']);
    const changed = booleanOption(args, 'changed');
    if (!changed && args.positionals.length > 0) {
      throw new UsageError('files are only accepted after --changed');
    }

    const loaded = await readConfig(args, io);
    const environments = changed
      ? changedEnvironments(loaded, args.positionals)
      : listEnvironments(loaded);

    io.stdout(render({ environments }, format));
    return ExitCode.Ok;
  },
};

function render(report: EnvsReport, format: 'text' | 'json' | 'codeowners'): string {
  switch (format) {
    case 'json':
      return toJson(report);
    case 'codeowners':
      return lines(codeownersLines(report.environments));
    case 'text':
      return lines(
        report.environments.map((environment) =>
          [environment.name, environment.ruleset, ...environment.approvers].join(' '),
        ),
      );
  }
}

function lines(entries: readonly string[]): string {
  return entries.map((entry) => `${entry}\n`).join('');
}
