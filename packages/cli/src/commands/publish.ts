import type { FlagParseIssue } from '@kurenwimpel/core';

import { booleanOption, ExitCode, FORMAT_OPTION, formatOption } from '../command.js';
import type { CliIo, Command } from '../command.js';
import { plural } from '../format/words.js';
import { publishRuleset } from '../publish/publisher.js';
import type { PublishResult } from '../publish/publisher.js';
import { loadRuleset, toJson } from '../ruleset-file.js';
import {
  CONFIG_OPTION,
  CONFIG_USAGE,
  environmentArgument,
  openTarget,
  rulesetArgument,
} from './environment.js';

export interface PublishReport extends PublishResult {
  readonly environment: string;
  readonly file: string;
}

export const publishCommand: Command = {
  name: 'publish',
  summary: "Publish a ruleset to an environment's target, as a new revision.",
  usage: [
    'Usage: kurenwimpel publish <env> [<file>] [--config <path>] [--allow-issues] [--format text|json]',
    '',
    "<file> defaults to the environment's ruleset in the config.",
    'Refuses a ruleset with parse issues and exits 1. --allow-issues publishes it anyway,',
    'for emergencies. Publishing the revision the target already serves writes nothing.',
    CONFIG_USAGE,
  ].join('\n'),
  options: { ...FORMAT_OPTION, ...CONFIG_OPTION, 'allow-issues': { type: 'boolean' } },
  async run(args, io) {
    const format = formatOption(args, ['text', 'json']);
    const [environment = '', named] = environmentArgument(args, [], ['<file>']);
    const allowIssues = booleanOption(args, 'allow-issues');
    const file = await rulesetArgument(args, io, environment, named);

    // Checked before any credential is read, so a broken ruleset fails the same
    // way in a pull request check that has none.
    const loaded = await loadRuleset(io, file);
    const { issues } = loaded.parsed;
    if (issues.length > 0 && !allowIssues) {
      reportRefusal(io, file, issues);
      if (format === 'json') io.stdout(toJson({ status: 'refused', issues }));
      return ExitCode.Findings;
    }

    const target = await openTarget(args, io, environment);
    const result = await publishRuleset(target, loaded.raw, { allowIssues, now: io.now });

    if (result.issues.length > 0) warnLoudly(io, file, result.issues);
    const report: PublishReport = { environment, file, ...result };
    io.stdout(format === 'json' ? toJson(report) : renderText(report));
    return ExitCode.Ok;
  },
};

function reportRefusal(io: CliIo, file: string, issues: readonly FlagParseIssue[]): void {
  for (const issue of issues) io.stderr(`${file}: ${issue.at}: ${issue.message}\n`);
  io.stderr(
    `refusing to publish ${file}: ${plural(issues.length, 'parse issue')}. ` +
      'Fix them, or pass --allow-issues in an emergency.\n',
  );
}

function warnLoudly(io: CliIo, file: string, issues: readonly FlagParseIssue[]): void {
  const banner = '!'.repeat(72);
  io.stderr(
    [
      banner,
      `WARNING: --allow-issues published ${file} with ${plural(issues.length, 'parse issue')}.`,
      'Clients drop every definition listed below and serve the rest.',
      ...issues.map((issue) => `  ${issue.at}: ${issue.message}`),
      banner,
      '',
    ].join('\n'),
  );
}

function renderText(report: PublishReport): string {
  if (report.status === 'unchanged') {
    return `${report.environment}: ${report.target} already serves ${report.revision}; nothing written\n`;
  }
  const was = report.previousRevision ?? 'nothing';
  return [
    `${report.environment}: published ${report.revision} to ${report.target}`,
    `  ${report.bytes} bytes, replacing ${was}`,
    '',
  ].join('\n');
}
