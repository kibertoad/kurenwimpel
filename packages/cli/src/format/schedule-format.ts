import { allIssues } from '../schedule/report.js';
import type { ScheduledChange, ScheduleReport } from '../schedule/report.js';
import { errorCommand, escapeRegExp, lineOf } from './validate-format.js';
import { plural } from './words.js';

function headline(report: ScheduleReport): string {
  const issues = allIssues(report).length;
  const count = report.entries.length;
  const pending = `${count} pending ${count === 1 ? 'entry' : 'entries'}`;
  return issues === 0 ? `${pending}, no issues` : `${pending}, ${plural(issues, 'issue')}`;
}

export function renderScheduleText(report: ScheduleReport): string {
  const lines = [`${report.schedule}: ${headline(report)}`];
  for (const issue of report.issues) lines.push(`  ${issue.entry}: ${issue.message}`);
  for (const entry of report.entries) {
    lines.push(`  ${entry.at} ${entry.id} (${entry.flag})`);
    for (const change of entry.changes) {
      lines.push(`    ${change.reshuffles ? '!' : '~'} ${change.at}: ${change.summary}`);
    }
    for (const issue of entry.issues) lines.push(`    issue: ${issue.at}: ${issue.message}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * GitHub-flavoured Markdown, one section of a pull request comment. Empty when
 * the environment has nothing scheduled, so the comment leaves the section out.
 */
export function renderScheduleMarkdown(report: ScheduleReport): string {
  if (report.entries.length === 0 && report.issues.length === 0) return '';

  const lines = ['### Scheduled changes', '', `\`${report.schedule}\`: ${headline(report)}.`];
  if (report.issues.length > 0) {
    lines.push('', ...report.issues.map((issue) => `- \`${issue.entry}\`: ${issue.message}`));
  }
  if (report.entries.length > 0) {
    lines.push('', '| When | Entry | Flag | Effect |', '| --- | --- | --- | --- |');
    for (const entry of report.entries) {
      const cells = [`\`${entry.at}\``, `\`${entry.id}\``, `\`${entry.flag}\``, effectOf(entry)];
      lines.push(`| ${cells.join(' | ')} |`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function effectOf(entry: ScheduledChange): string {
  const parts = [
    ...entry.changes.map((change) =>
      change.reshuffles ? `**${change.kind}**: ${change.summary}` : change.summary,
    ),
    ...entry.issues.map((issue) => `**issue**: ${issue.message}`),
  ];
  return parts.length === 0 ? 'no change' : parts.join('<br>').replaceAll('|', String.raw`\|`);
}

/** One `::error` per issue, on the line of the entry's id when it has one. */
export function renderScheduleGithub(report: ScheduleReport, text: string): string {
  return allIssues(report)
    .map((issue) =>
      errorCommand({
        path: report.schedule,
        line: entryLine(text, issue.entry, issue.message),
        title: `kurenwimpel schedule: ${issue.entry}`,
        message: issue.message,
      }),
    )
    .join('');
}

function entryLine(text: string, entry: string, message: string): number | undefined {
  if (entry === '$') return lineOf(text, { at: '$', message });
  const pattern = new RegExp(`"id"\\s*:\\s*${escapeRegExp(JSON.stringify(entry))}`, 'u');
  const match = pattern.exec(text);
  return match === null ? undefined : text.slice(0, match.index).split('\n').length;
}
