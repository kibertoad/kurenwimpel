import type { FlagDiff, RulesetDiff, SegmentDiff } from '../diff/types.js';
import { plural } from './words.js';

interface Entry {
  readonly noun: 'flag' | 'segment';
  readonly diff: FlagDiff;
  readonly referencedBy?: readonly string[];
}

function entriesOf(diff: RulesetDiff): Entry[] {
  return [
    ...diff.flags.map((entry): Entry => ({ noun: 'flag', diff: entry })),
    ...diff.segments.map((entry: SegmentDiff): Entry => ({
      noun: 'segment',
      diff: entry,
      referencedBy: entry.referencedBy,
    })),
  ];
}

function headline(diff: RulesetDiff): string {
  const total = diff.flags.length + diff.segments.length;
  if (total === 0) return 'No changes.';

  const reshuffling = entriesOf(diff).flatMap((entry) =>
    entry.diff.changes.filter((item) => item.reshuffles),
  ).length;
  const counts = `${plural(diff.flags.length, 'flag')} and ${plural(diff.segments.length, 'segment')} differ.`;
  return reshuffling === 0
    ? counts
    : `${counts} ${plural(reshuffling, 'change')} ${reshuffling === 1 ? 'reshuffles' : 'reshuffle'} subjects.`;
}

function usedBy(entry: Entry): string {
  const flags = entry.referencedBy ?? [];
  return flags.length === 0 ? '' : ` (used by ${flags.join(', ')})`;
}

export function renderDiffText(diff: RulesetDiff): string {
  const lines: string[] = [];
  for (const entry of entriesOf(diff)) {
    lines.push(`${entry.noun} ${entry.diff.key}: ${entry.diff.status}${usedBy(entry)}`);
    for (const item of entry.diff.changes) {
      lines.push(`  ${item.reshuffles ? '!' : '~'} ${item.at}: ${item.summary}`);
    }
  }
  if (lines.length > 0) lines.push('');
  lines.push(headline(diff));
  return `${lines.join('\n')}\n`;
}

/** GitHub-flavoured Markdown, sized for a pull request comment. */
export function renderDiffMarkdown(diff: RulesetDiff): string {
  const lines = ['### Ruleset diff', '', headline(diff)];

  for (const entry of entriesOf(diff)) {
    lines.push(
      '',
      `#### ${entry.noun} \`${entry.diff.key}\`: ${entry.diff.status}${usedBy(entry)}`,
    );
    if (entry.diff.changes.length === 0) continue;

    lines.push('', '| Change | Where | Effect |', '| --- | --- | --- |');
    for (const item of entry.diff.changes) {
      const kind = item.reshuffles ? `**${item.kind}**` : item.kind;
      lines.push(`| ${kind} | \`${item.at}\` | ${escapeCell(item.summary)} |`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function escapeCell(text: string): string {
  return text.replaceAll('|', String.raw`\|`);
}
