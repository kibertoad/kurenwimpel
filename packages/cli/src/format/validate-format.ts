import type { FlagParseIssue } from '@kurenwimpel/core';

import { plural } from './words.js';

export interface ValidatedText {
  readonly path: string;
  readonly flags: number;
  readonly segments: number;
  readonly issues: readonly FlagParseIssue[];
  /** The file as read, to place each issue on a line. */
  readonly text: string;
}

function counts(file: ValidatedText): string {
  return `${plural(file.flags, 'flag')}, ${plural(file.segments, 'segment')}`;
}

export function renderValidateText(files: readonly ValidatedText[]): string {
  const lines: string[] = [];
  for (const file of files) {
    if (file.issues.length === 0) {
      lines.push(`${file.path}: ok (${counts(file)})`);
      continue;
    }
    lines.push(`${file.path}: ${plural(file.issues.length, 'issue')} (${counts(file)} loaded)`);
    for (const issue of file.issues) lines.push(`  ${issue.at}: ${issue.message}`);
  }
  return `${lines.join('\n')}\n`;
}

/** GitHub-flavoured Markdown, one section of a pull request comment. */
export function renderValidateMarkdown(files: readonly ValidatedText[]): string {
  const lines = ['### Validation'];
  for (const file of files) {
    const path = `\`${file.path}\``;
    if (file.issues.length === 0) {
      lines.push('', `${path}: no issues (${counts(file)}).`);
      continue;
    }
    lines.push(
      '',
      `${path}: **${plural(file.issues.length, 'issue')}** (${counts(file)} loaded).`,
      '',
      ...file.issues.map((issue) => `- \`${issue.at}\`: ${issue.message}`),
    );
  }
  return `${lines.join('\n')}\n`;
}

/**
 * One `::error` workflow command per issue, which GitHub Actions turns into an
 * annotation on the file, and on the line of the definition when it can be found.
 */
export function renderValidateGithub(files: readonly ValidatedText[]): string {
  return files
    .flatMap((file) =>
      file.issues.map((issue) =>
        errorCommand({
          path: file.path,
          line: lineOf(file.text, issue),
          title: `kurenwimpel: ${issue.at}`,
          message: issue.message,
        }),
      ),
    )
    .join('');
}

export interface Annotation {
  readonly path: string;
  readonly line: number | undefined;
  readonly title: string;
  readonly message: string;
}

/** One `::error` workflow command, with its newline. */
export function errorCommand(annotation: Annotation): string {
  const properties = [
    `file=${property(annotation.path.replaceAll('\\', '/'))}`,
    ...(annotation.line === undefined ? [] : [`line=${annotation.line}`]),
    `title=${property(annotation.title)}`,
  ];
  return `::error ${properties.join(',')}::${data(annotation.message)}\n`;
}

/**
 * The 1-based line an issue points at: the JSON parser's own line for a file
 * that is not JSON, otherwise the first line naming the definition's key.
 */
export function lineOf(text: string, issue: FlagParseIssue): number | undefined {
  if (issue.at === '$') {
    const match = /\(line (\d+) column \d+\)/u.exec(issue.message);
    return match === null ? undefined : Number(match[1]);
  }

  const quoted = escapeRegExp(JSON.stringify(issue.at));
  const patterns = [new RegExp(`"key"\\s*:\\s*${quoted}`, 'u'), new RegExp(`${quoted}\\s*:`, 'u')];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match !== null) return text.slice(0, match.index).split('\n').length;
  }
  return undefined;
}

export function escapeRegExp(text: string): string {
  return text.replaceAll(/[$()*+.?[\\\]^{|}]/gu, String.raw`\$&`);
}

/** Escaping from the workflow command reference. */
function data(text: string): string {
  return text.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

function property(text: string): string {
  return data(text).replaceAll(':', '%3A').replaceAll(',', '%2C');
}
