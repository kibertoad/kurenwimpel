import { ExitCode, FORMAT_OPTION, formatOption, stringOption } from '../command.js';
import type { Command } from '../command.js';
import { listRevisions, rollbackRuleset } from '../publish/rollback.js';
import type { RevisionEntry, RollbackResult } from '../publish/rollback.js';
import { toJson } from '../ruleset-file.js';
import { CONFIG_OPTION, CONFIG_USAGE, environmentArgument, openTarget } from './environment.js';

export interface RollbackReport extends RollbackResult {
  readonly environment: string;
}

export interface RevisionsReport {
  readonly environment: string;
  /** Newest first. */
  readonly revisions: readonly RevisionEntry[];
}

export const rollbackCommand: Command = {
  name: 'rollback',
  summary: 'Point an environment back at a stored revision, without a rebuild.',
  usage: [
    'Usage: kurenwimpel rollback <env> [--to <revision>] [--config <path>] [--format text|json]',
    '',
    '--to takes a revision or a unique prefix of one. Without it, the environment goes back',
    'to the revision published before the current one.',
    CONFIG_USAGE,
  ].join('\n'),
  options: { ...FORMAT_OPTION, ...CONFIG_OPTION, to: { type: 'string' } },
  async run(args, io) {
    const format = formatOption(args, ['text', 'json']);
    const [environment = ''] = environmentArgument(args);
    const target = await openTarget(args, io, environment);

    const to = stringOption(args, 'to');
    const result = await rollbackRuleset(target, to === undefined ? {} : { to });

    const report: RollbackReport = { environment, ...result };
    io.stdout(format === 'json' ? toJson(report) : renderRollback(report));
    return ExitCode.Ok;
  },
};

export const revisionsCommand: Command = {
  name: 'revisions',
  summary: 'List the revisions stored for an environment, newest first.',
  usage: [
    'Usage: kurenwimpel revisions <env> [--config <path>] [--format text|json]',
    '',
    'The revision served now is marked with *.',
    CONFIG_USAGE,
  ].join('\n'),
  options: { ...FORMAT_OPTION, ...CONFIG_OPTION },
  async run(args, io) {
    const format = formatOption(args, ['text', 'json']);
    const [environment = ''] = environmentArgument(args);
    const target = await openTarget(args, io, environment);

    const report: RevisionsReport = { environment, revisions: await listRevisions(target) };
    io.stdout(format === 'json' ? toJson(report) : renderRevisions(report));
    return ExitCode.Ok;
  },
};

function renderRollback(report: RollbackReport): string {
  if (report.status === 'unchanged') {
    return `${report.environment}: already serves ${report.to}; nothing written\n`;
  }
  return `${report.environment}: rolled back from ${report.from ?? 'nothing'} to ${report.to}\n`;
}

function renderRevisions(report: RevisionsReport): string {
  if (report.revisions.length === 0) return `${report.environment}: no revisions stored\n`;
  const lines = report.revisions.map((entry) => {
    const marker = entry.current ? '*' : ' ';
    return `${marker} ${entry.revision}  ${entry.publishedAt ?? 'unknown time'}`;
  });
  return `${lines.join('\n')}\n`;
}
