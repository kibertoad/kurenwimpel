/**
 * @kurenwimpel/core - runtime-agnostic feature flag evaluation.
 *
 * Nothing in this package touches a platform API. Service wrappers supply a
 * FlagProvider; everything else here is pure data and pure functions.
 */

export { FeatureFlagClient } from './client.js';
export type { ClientErrorInfo, FeatureFlagClientOptions, ResolvedEvaluation } from './client.js';

export {
  evaluateFlag,
  matchesCondition,
  matchesRule,
  pickFromRollout,
  TARGETING_KEY_ATTRIBUTE,
} from './evaluate.js';

export { BUCKET_COUNT, bucketOf, murmurHash3 } from './hash.js';

export { FlagParseError, parseFlagDefinition, parseFlagDefinitions } from './parse.js';
export type { FlagParseIssue, ParseFlagsResult } from './parse.js';

export { createSnapshot, EMPTY_SNAPSHOT, StaticProvider } from './snapshot.js';
export type { FlagProvider, FlagSnapshot, SnapshotMeta } from './snapshot.js';

export { EvaluationErrorCode, EvaluationReason } from './types.js';
export type {
  AttributeValue,
  Condition,
  ConditionOperator,
  EvaluationContext,
  EvaluationResult,
  FlagDefinition,
  FlagValue,
  JsonValue,
  RolloutBucket,
  TargetingRule,
} from './types.js';
