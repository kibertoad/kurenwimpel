import type { FlagParseIssue } from '@kurenwimpel/core';

import { booleanOption, ExitCode, FORMAT_OPTION, formatOption, UsageError } from '../command.js';
import type { Command } from '../command.js';
import { diffRuleset } from '../diff/ruleset-diff.js';
import type { RulesetDiff } from '../diff/types.js';
import { renderDiffMarkdown, renderDiffText } from '../format/diff-format.js';
import { loadRuleset, toJson, warnAboutIssues } from '../ruleset-file.js';

export interface DiffReport extends RulesetDiff {
  readonly old: string;
  readonly new: string;
  /** Parse issues of each side. The diff covers only what parsed. */
  readonly issues: {
    readonly old: readonly FlagParseIssue[];
    readonly new: readonly FlagParseIssue[];
  };
}

export const diffCommand: Command = {
  name: 'diff',
  summary: 'Show what changing one ruleset into another does to live traffic.',
  usage: [
    'Usage: kurenwimpel diff <old> <new> [--format text|json|markdown] [--exit-code]',
    '',
    'Compares flag by flag and segment by segment, and classifies each change by its',
    'effect on traffic. Exits 0 whether or not anything changed; with --exit-code it',
    'exits 1 when anything did.',
  ].join('\n'),
  options: { ...FORMAT_OPTION, 'exit-code': { type: 'boolean' } },
  async run(args, io) {
    const format = formatOption(args, ['text', 'json', 'markdown']);
    const [oldPath, newPath, ...extra] = args.positionals;
    if (oldPath === undefined || newPath === undefined || extra.length > 0) {
      throw new UsageError('expected exactly two files: <old> <new>');
    }

    const before = await loadRuleset(io, oldPath);
    const after = await loadRuleset(io, newPath);
    const report: DiffReport = {
      old: oldPath,
      new: newPath,
      issues: { old: before.parsed.issues, new: after.parsed.issues },
      ...diffRuleset(before.parsed, after.parsed),
    };

    warnAboutIssues(io, before);
    warnAboutIssues(io, after);
    io.stdout(render(report, format));

    const changed = report.flags.length + report.segments.length > 0;
    return changed && booleanOption(args, 'exit-code') ? ExitCode.Findings : ExitCode.Ok;
  },
};

function render(report: DiffReport, format: 'text' | 'json' | 'markdown'): string {
  switch (format) {
    case 'json':
      return toJson(report);
    case 'markdown':
      return renderDiffMarkdown(report);
    case 'text':
      return renderDiffText(report);
  }
}
