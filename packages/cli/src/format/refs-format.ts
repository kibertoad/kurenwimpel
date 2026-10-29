import type { FlagReference } from '../refs/scan.js';
import { lineOf, workflowCommand } from './validate-format.js';
import { plural } from './words.js';

export interface RefsResult {
  readonly file: string;
  readonly flags: number;
  readonly files: number;
  readonly references: readonly FlagReference[];
  /** Flags in the ruleset that no getter names. */
  readonly unreferenced: readonly string[];
  /** Getter calls naming a key the ruleset does not define. */
  readonly unknown: readonly FlagReference[];
}

function headline(result: RefsResult): string {
  return (
    `${plural(result.flags, 'flag')}, ${plural(result.references.length, 'reference')} ` +
    `in ${plural(result.files, 'source file')}`
  );
}

export function renderRefsText(result: RefsResult): string {
  const lines = [`${result.file}: ${headline(result)}`];
  for (const key of result.unreferenced) lines.push(`  [unreferenced] ${key}`);
  for (const ref of result.unknown) {
    lines.push(`  [unknown] ${ref.file}:${ref.line} names "${ref.key}", which is not a flag`);
  }
  return `${lines.join('\n')}\n`;
}

/** GitHub-flavoured Markdown, one section of a pull request comment. */
export function renderRefsMarkdown(result: RefsResult): string {
  const lines = ['### References', '', `\`${result.file}\`: ${headline(result)}.`];
  if (result.unreferenced.length > 0) {
    const items = result.unreferenced.map((key) => `- \`${key}\``);
    lines.push('', 'Flags no code reads:', '', ...items);
  }
  if (result.unknown.length > 0) {
    const items = result.unknown.map((ref) => `- \`${ref.key}\` at \`${ref.file}:${ref.line}\``);
    lines.push('', 'Keys the ruleset does not define:', '', ...items);
  }
  return `${lines.join('\n')}\n`;
}

/** A warning on the line of each unreferenced flag, and on each call naming an unknown key. */
export function renderRefsGithub(result: RefsResult, text: string): string {
  const commands = [
    ...result.unreferenced.map((key) =>
      workflowCommand('warning', {
        file: result.file,
        line: lineOf(text, { at: key, message: '' }),
        title: 'kurenwimpel refs: unreferenced',
        message: `${key} is not read by any getter in the scanned source`,
      }),
    ),
    ...result.unknown.map((ref) =>
      workflowCommand('warning', {
        file: ref.file,
        line: ref.line,
        title: 'kurenwimpel refs: unknown flag',
        message: `"${ref.key}" is not a flag in ${result.file}`,
      }),
    ),
  ];
  return commands.map((command) => `${command}\n`).join('');
}
