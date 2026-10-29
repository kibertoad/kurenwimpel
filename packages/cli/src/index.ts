/**
 * @kurenwimpel/cli: the `kurenwimpel` command, and the pieces it is built from
 * for tools that want the same diff or explanation without spawning a process.
 */

export { run } from './cli.js';
export { ExitCode, UsageError } from './command.js';
export type { CliIo, Command, CommandArgs, OptionValue } from './command.js';
export { COMMANDS } from './commands/registry.js';
export type { DiffReport } from './commands/diff.js';
export type { EvalReport } from './commands/eval.js';
export type { ValidatedFile, ValidateReport } from './commands/validate.js';
export { diffRuleset } from './diff/ruleset-diff.js';
export type { RulesetSide } from './diff/ruleset-diff.js';
export type {
  Change,
  ChangeKind,
  EntryStatus,
  FlagDiff,
  RulesetDiff,
  SegmentDiff,
} from './diff/types.js';
export { explain, snapshotOf } from './eval/explain.js';
export type { Explanation, PrerequisiteOutcomeReport, PrerequisiteStatus } from './eval/explain.js';
export { renderDiffMarkdown, renderDiffText } from './format/diff-format.js';
export { loadRuleset } from './ruleset-file.js';
export type { LoadedRuleset } from './ruleset-file.js';
