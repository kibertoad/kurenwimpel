import type { LintFinding } from '../lint/rules.js';
import { lineOf, workflowCommand } from './validate-format.js';
import { plural } from './words.js';

export interface LintedText {
  readonly path: string;
  readonly flags: number;
  readonly findings: readonly LintFinding[];
  /** The file as read, to place each finding on the line of its flag. */
  readonly text: string;
}

export function renderLintText(file: LintedText): string {
  if (file.findings.length === 0) {
    return `${file.path}: no findings (${plural(file.flags, 'flag')})\n`;
  }
  const lines = [`${file.path}: ${plural(file.findings.length, 'finding')}`];
  for (const finding of file.findings) {
    lines.push(`  [${finding.rule}] ${finding.flag} ${finding.message}`);
  }
  return `${lines.join('\n')}\n`;
}

/** GitHub-flavoured Markdown, one section of a pull request comment. */
export function renderLintMarkdown(file: LintedText): string {
  const path = `\`${file.path}\``;
  if (file.findings.length === 0) {
    return `### Lint\n\n${path}: no findings (${plural(file.flags, 'flag')}).\n`;
  }
  const lines = [
    '### Lint',
    '',
    `${path}: **${plural(file.findings.length, 'finding')}**.`,
    '',
    ...file.findings.map(
      (finding) => `- **${finding.rule}**: \`${finding.flag}\` ${finding.message}`,
    ),
  ];
  return `${lines.join('\n')}\n`;
}

/** One workflow command per finding: `::error` for an expired flag, `::warning` for the rest. */
export function renderLintGithub(file: LintedText): string {
  return file.findings
    .map(
      (finding) =>
        `${workflowCommand(finding.severity, {
          file: file.path,
          line: lineOf(file.text, { at: finding.flag, message: finding.message }),
          title: `kurenwimpel lint: ${finding.rule}`,
          message: `${finding.flag} ${finding.message}`,
        })}\n`,
    )
    .join('');
}
