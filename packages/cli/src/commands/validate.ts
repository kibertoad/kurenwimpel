import { parseRuleset } from '@kurenwimpel/core';
import type { FlagParseIssue } from '@kurenwimpel/core';

import { ExitCode, FORMAT_OPTION, formatOption, UsageError } from '../command.js';
import type { CliIo, Command } from '../command.js';
import { plural } from '../format/words.js';
import { messageOf, readText, toJson } from '../ruleset-file.js';

export interface ValidatedFile {
  readonly path: string;
  readonly flags: number;
  readonly segments: number;
  readonly issues: readonly FlagParseIssue[];
}

export interface ValidateReport {
  readonly valid: boolean;
  readonly files: readonly ValidatedFile[];
}

export const validateCommand: Command = {
  name: 'validate',
  summary: 'Parse ruleset files and report every issue the SDK would report.',
  usage: [
    'Usage: kurenwimpel validate <file...> [--format text|json]',
    '',
    'Exits 1 when any file has an issue, including a file that is not valid JSON.',
  ].join('\n'),
  options: FORMAT_OPTION,
  async run(args, io) {
    const format = formatOption(args, ['text', 'json']);
    if (args.positionals.length === 0) throw new UsageError('expected at least one file');

    const files = await Promise.all(args.positionals.map((path) => validateFile(io, path)));

    const report: ValidateReport = {
      valid: files.every((file) => file.issues.length === 0),
      files,
    };
    io.stdout(format === 'json' ? toJson(report) : renderText(report));
    return report.valid ? ExitCode.Ok : ExitCode.Findings;
  },
};

async function validateFile(io: CliIo, path: string): Promise<ValidatedFile> {
  const text = await readText(io, path);

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { path, flags: 0, segments: 0, issues: [{ at: '$', message: messageOf(error) }] };
  }

  const { flags, segments, issues } = parseRuleset(raw);
  return { path, flags: flags.length, segments: segments.length, issues };
}

function renderText(report: ValidateReport): string {
  const lines: string[] = [];
  for (const file of report.files) {
    const counts = `${plural(file.flags, 'flag')}, ${plural(file.segments, 'segment')}`;
    if (file.issues.length === 0) {
      lines.push(`${file.path}: ok (${counts})`);
      continue;
    }
    lines.push(`${file.path}: ${plural(file.issues.length, 'issue')} (${counts} loaded)`);
    for (const issue of file.issues) lines.push(`  ${issue.at}: ${issue.message}`);
  }
  return `${lines.join('\n')}\n`;
}
