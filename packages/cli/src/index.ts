/**
 * @kurenwimpel/cli: the `kurenwimpel` command, and the pieces it is built from
 * for tools that want the same diff, explanation or publish without spawning a
 * process.
 */

export { run } from './cli.js';
export { ExitCode, UsageError } from './command.js';
export type { CliIo, Command, CommandArgs, OptionValue } from './command.js';
export { COMMANDS } from './commands/registry.js';
export type { DiffReport } from './commands/diff.js';
export type { PublishReport } from './commands/publish.js';
export type { RevisionsReport, RollbackReport } from './commands/rollback.js';
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
export type { EnvsReport } from './commands/envs.js';
export type { ScheduleApplyReport } from './commands/schedule-apply.js';
export type { ScheduledChange, ScheduleReport } from './schedule/report.js';
export { parseSchedule } from './schedule/schedule-file.js';
export type { ParsedSchedule, ScheduleEntry, ScheduleIssue } from './schedule/schedule-file.js';
export { patchDocument, simulate } from './schedule/simulate.js';
export type { ScheduleStep, Simulation } from './schedule/simulate.js';
export { renderValidateGithub, renderValidateMarkdown } from './format/validate-format.js';
export type { ValidatedText } from './format/validate-format.js';
export { changedEnvironments, codeownersLines, listEnvironments } from './config/environments.js';
export type { EnvironmentSummary } from './config/environments.js';
export {
  environmentOf,
  loadConfig,
  parseConfig,
  resolveRuleset,
  resolveSchedule,
  resolveTarget,
} from './config/load-config.js';
export type { LoadedConfig } from './config/load-config.js';
export { ConfigError } from './config/fields.js';
export { DEFAULT_CONFIG_PATH, DEFAULT_KEEP } from './config/types.js';
export type {
  EnvironmentConfig,
  FileTargetConfig,
  KurenwimpelConfig,
  KvTargetConfig,
  ObjectTargetConfig,
  TargetConfig,
} from './config/types.js';
export { PayloadTooLargeError } from './publish/payload-too-large-error.js';
export { publishRuleset } from './publish/publisher.js';
export { RulesetIssuesError } from './publish/ruleset-issues-error.js';
export type { PublishOptions, PublishResult } from './publish/publisher.js';
export { canonicalJson, revisionOf } from './publish/revision.js';
export type { RevisionedPayload } from './publish/revision.js';
export { listRevisions, RevisionError, rollbackRuleset } from './publish/rollback.js';
export type { RevisionEntry, RollbackResult } from './publish/rollback.js';
export { createTarget } from './targets/create-target.js';
export { KV_MAX_VALUE_BYTES } from './targets/kv-target.js';
export { OBJECT_MAX_PUT_BYTES } from './targets/object-target.js';
export { MissingCredentialError } from './targets/target.js';
export type {
  PublishedRevision,
  PublishTarget,
  RevisionStore,
  StoredRevision,
  TargetDeps,
} from './targets/target.js';
