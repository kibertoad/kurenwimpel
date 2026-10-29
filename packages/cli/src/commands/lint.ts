import { parseRuleset } from '@kurenwimpel/core';
import type { FlagParseIssue } from '@kurenwimpel/core';

import {
  booleanOption,
  ExitCode,
  FORMAT_OPTION,
  formatOption,
  stringOption,
  UsageError,
} from '../command.js';
import type { CliIo, Command, CommandArgs } from '../command.js';
import { loadConfig } from '../config/load-config.js';
import { renderLintGithub, renderLintMarkdown, renderLintText } from '../format/lint-format.js';
import type { LintedText } from '../format/lint-format.js';
import { lintFlags } from '../lint/rules.js';
import type { LintFinding } from '../lint/rules.js';
import { switchedOffSince } from '../lint/since-git.js';
import { parseJson, readText, toJson, warnAboutIssues } from '../ruleset-file.js';

export interface LintReport {
  readonly file: string;
  /** The time the rules were checked against, ISO 8601. */
  readonly now: string;
  readonly findings: readonly LintFinding[];
  /** Parse issues of the file. The findings cover what parsed. */
  readonly issues: readonly FlagParseIssue[];
}

type LintFormat = 'text' | 'json' | 'markdown' | 'github';

export const lintCommand: Command = {
  name: 'lint',
  summary: 'Find flags that should be removed: expired, fully rolled out, or switched off.',
  usage: [
    'Usage: kurenwimpel lint <file> [--since-git] [--now <date>] [--config <path>]',
    '                        [--format text|json|markdown|github]',
    '',
    'Exits 1 when there is a finding. ops and permission flags are exempt from the',
    'staleness rules. --since-git reads `git log` for how long each disabled flag has',
    'been off. --now replaces the current time. The missing-owner warning is turned on',
    'by "lint": { "requireOwner": true } in the file --config names.',
  ].join('\n'),
  options: {
    ...FORMAT_OPTION,
    config: { type: 'string', short: 'c' },
    'since-git': { type: 'boolean' },
    now: { type: 'string' },
  },
  async run(args, io) {
    const format = formatOption(args, ['text', 'json', 'markdown', 'github']);
    const [path, ...extra] = args.positionals;
    if (path === undefined || extra.length > 0) throw new UsageError('expected exactly one file');

    const now = nowOption(args, io);
    const requireOwner = await requireOwnerOption(args, io);
    const text = await readText(io, path);
    const parsed = parseRuleset(parseJson(text, path));
    warnAboutIssues(io, { path, raw: undefined, parsed });

    const disabled = parsed.flags.filter((flag) => !flag.enabled).map((flag) => flag.key);
    const offSince = booleanOption(args, 'since-git')
      ? await switchedOffSince(io, path, disabled)
      : undefined;
    const findings = lintFlags(parsed.flags, {
      now,
      requireOwner,
      ...(offSince === undefined ? {} : { offSince }),
    });

    const report: LintReport = {
      file: path,
      now: now.toISOString(),
      findings,
      issues: parsed.issues,
    };
    io.stdout(render(report, { path, flags: parsed.flags.length, findings, text }, format));
    return findings.length === 0 ? ExitCode.Ok : ExitCode.Findings;
  },
};

function nowOption(args: CommandArgs, io: CliIo): Date {
  const value = stringOption(args, 'now');
  if (value === undefined) return io.now();
  const now = new Date(value);
  if (Number.isNaN(now.getTime())) {
    throw new UsageError(`--now must be a date such as 2026-10-29 or an ISO 8601 time`);
  }
  return now;
}

async function requireOwnerOption(args: CommandArgs, io: CliIo): Promise<boolean> {
  const path = stringOption(args, 'config');
  if (path === undefined) return false;
  const { config } = await loadConfig(io, path);
  return config.lint?.requireOwner ?? false;
}

function render(report: LintReport, file: LintedText, format: LintFormat): string {
  switch (format) {
    case 'json':
      return toJson(report);
    case 'markdown':
      return renderLintMarkdown(file);
    case 'github':
      return renderLintGithub(file);
    case 'text':
      return renderLintText(file);
  }
}
