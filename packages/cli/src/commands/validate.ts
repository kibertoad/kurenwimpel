import { parseRuleset } from '@kurenwimpel/core';
import type { FlagParseIssue } from '@kurenwimpel/core';

import { ExitCode, FORMAT_OPTION, formatOption, UsageError } from '../command.js';
import type { CliIo, Command } from '../command.js';
import {
  renderValidateGithub,
  renderValidateMarkdown,
  renderValidateText,
} from '../format/validate-format.js';
import type { ValidatedText } from '../format/validate-format.js';
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

type ValidateFormat = 'text' | 'json' | 'markdown' | 'github';

export const validateCommand: Command = {
  name: 'validate',
  summary: 'Parse ruleset files and report every issue the SDK would report.',
  usage: [
    'Usage: kurenwimpel validate <file...> [--format text|json|markdown|github]',
    '',
    'Exits 1 when any file has an issue, including a file that is not valid JSON.',
    '--format github prints one ::error workflow command per issue, which GitHub Actions',
    'shows as an annotation on the file and line.',
  ].join('\n'),
  options: FORMAT_OPTION,
  async run(args, io) {
    const format = formatOption(args, ['text', 'json', 'markdown', 'github']);
    if (args.positionals.length === 0) throw new UsageError('expected at least one file');

    const files = await Promise.all(args.positionals.map((path) => validateFile(io, path)));
    const valid = files.every((file) => file.issues.length === 0);

    io.stdout(render(files, valid, format));
    return valid ? ExitCode.Ok : ExitCode.Findings;
  },
};

async function validateFile(io: CliIo, path: string): Promise<ValidatedText> {
  const text = await readText(io, path);

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { path, flags: 0, segments: 0, issues: [{ at: '$', message: messageOf(error) }], text };
  }

  const { flags, segments, issues } = parseRuleset(raw);
  return { path, flags: flags.length, segments: segments.length, issues, text };
}

function render(files: readonly ValidatedText[], valid: boolean, format: ValidateFormat): string {
  switch (format) {
    case 'json': {
      const report: ValidateReport = {
        valid,
        files: files.map(({ path, flags, segments, issues }) => ({
          path,
          flags,
          segments,
          issues,
        })),
      };
      return toJson(report);
    }
    case 'markdown':
      return renderValidateMarkdown(files);
    case 'github':
      return renderValidateGithub(files);
    case 'text':
      return renderValidateText(files);
  }
}
