/**
 * @kurenwimpel/core - runtime-agnostic feature flag evaluation.
 *
 * Nothing in this package touches a platform API. Service wrappers supply a
 * FlagProvider; everything else here is pure data and pure functions.
 *
 * The source is grouped by role:
 * - `model/`      — the domain types: flags, segments, contexts, results.
 * - `evaluation/` — the pure functions that decide what a context is served.
 * - `parsing/`    — validation for definitions arriving as untrusted JSON.
 * - `runtime/`    — snapshots, providers, and the client that ties them together.
 */

// model
export type { AttributeValue, EvaluationContext } from './model/context.js';
export type {
  Condition,
  ConditionOperator,
  FlagDefinition,
  FlagMetadata,
  Prerequisite,
  Rollout,
  RolloutBucket,
  RolloutSplit,
  TargetingRule,
  TrafficAllocation,
  VariantTarget,
} from './model/flag.js';
export type { FlagValue, JsonObject, JsonValue } from './model/json.js';
export { toOfrepErrorCode, toOfrepReason } from './model/ofrep.js';
export type { OfrepErrorCode, OfrepReason } from './model/ofrep.js';
export { EvaluationErrorCode, EvaluationReason } from './model/result.js';
export type { EvaluationResult } from './model/result.js';
export type { Segment, SegmentDefinition, SegmentRule } from './model/segment.js';

// evaluation
export {
  BUCKET_COUNT,
  bucketOf,
  drawAllocation,
  isAllocated,
  murmurHash3,
  settledAllocation,
} from './evaluation/bucketing.js';
export {
  isInSegment,
  matchesCondition,
  matchesConditions,
  matchesRule,
  readAttribute,
  readTargetingKey,
} from './evaluation/conditions.js';
export type { SegmentMap } from './evaluation/conditions.js';
export { createSharedMemo, evaluateFlag } from './evaluation/evaluate.js';
export type {
  EvaluationEnvironment,
  PrerequisiteOutcome,
  SharedPrerequisiteMemo,
} from './evaluation/evaluate.js';
export { compileSegment } from './evaluation/segments.js';
export { buildTargetIndex, compileTargets } from './evaluation/targets.js';
export type { TargetIndex } from './evaluation/targets.js';
export { compareVersions, parseVersion } from './evaluation/semver.js';
export type { ParsedVersion } from './evaluation/semver.js';

// parsing
export { parseCondition } from './parsing/condition.js';
export { parseFlagDefinition } from './parsing/flag.js';
export { FlagParseError } from './parsing/primitives.js';
export type { FlagParseIssue, ParseFailureScope } from './parsing/primitives.js';
export { parseFlagDefinitions, parseRuleset, parseSegmentDefinitions } from './parsing/ruleset.js';
export type {
  ParseFlagsResult,
  ParseRulesetResult,
  ParseSegmentsResult,
} from './parsing/ruleset.js';
export { parseSegmentDefinition } from './parsing/segment.js';

// runtime
export { FeatureFlagClient } from './runtime/client.js';
export type { ResolvedEvaluation } from './runtime/client.js';
export type {
  BulkEvaluationOptions,
  ClientErrorInfo,
  FeatureFlagClientOptions,
} from './runtime/client-options.js';
export type { ImpressionEvent } from './runtime/impressions.js';
export {
  createImpressionBatcher,
  DEFAULT_IMPRESSION_DEDUP_WINDOW_MS,
  DEFAULT_IMPRESSION_FLUSH_INTERVAL_MS,
  DEFAULT_IMPRESSION_MAX_BATCH_SIZE,
  DEFAULT_IMPRESSION_MAX_DEDUP_KEYS,
  DEFAULT_IMPRESSION_MAX_QUEUE_SIZE,
} from './runtime/impression-batcher.js';
export type {
  ImpressionBatcher,
  ImpressionBatcherOptions,
  ImpressionBatcherStats,
  ScheduledImpressionOptions,
} from './runtime/impression-batcher.js';
export { CountingMetrics } from './runtime/metrics.js';
export type { EvaluationCount, MetricsSink } from './runtime/metrics.js';
export type { ClientStatus } from './runtime/status.js';
export { StaticProvider } from './runtime/provider.js';
export type {
  FlagProvider,
  ProviderLoadContext,
  StaticProviderContents,
} from './runtime/provider.js';
export {
  isStoredRuleset,
  loadWithFallback,
  snapshotFromRuleset,
} from './runtime/last-known-good.js';
export type {
  LastKnownGoodStore,
  RulesetSourceOptions,
  StoredRuleset,
} from './runtime/last-known-good.js';
export { completeSnapshot, createSnapshot, EMPTY_SNAPSHOT } from './runtime/snapshot.js';
export type { FlagSnapshot, SnapshotMeta, SnapshotOrigin } from './runtime/snapshot.js';
