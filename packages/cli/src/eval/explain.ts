import {
  createSharedMemo,
  createSnapshot,
  EvaluationErrorCode,
  EvaluationReason,
  evaluateFlag,
} from '@kurenwimpel/core';
import type {
  EvaluationContext,
  EvaluationResult,
  FlagSnapshot,
  ParseRulesetResult,
  Prerequisite,
  SharedPrerequisiteMemo,
} from '@kurenwimpel/core';

export type PrerequisiteStatus = 'satisfied' | 'failed' | 'missing' | 'not-evaluated';

export interface PrerequisiteOutcomeReport {
  readonly flag: string;
  readonly requiredVariants: readonly string[];
  /** `not-evaluated` when evaluation stopped before reaching it. */
  readonly status: PrerequisiteStatus;
  readonly variant?: string;
  readonly reason?: EvaluationReason;
  readonly errorCode?: EvaluationErrorCode;
}

export interface Explanation extends EvaluationResult {
  readonly prerequisites: readonly PrerequisiteOutcomeReport[];
}

export function snapshotOf(parsed: ParseRulesetResult): FlagSnapshot {
  return createSnapshot(parsed.flags, {}, parsed.segments);
}

/** Evaluates one flag and reports each prerequisite as the evaluator saw it. */
export function explain(
  snapshot: FlagSnapshot,
  key: string,
  context: EvaluationContext,
): Explanation {
  const flag = snapshot.flags.get(key);
  if (flag === undefined) {
    return {
      key,
      value: undefined,
      variant: undefined,
      reason: EvaluationReason.Error,
      errorCode: EvaluationErrorCode.FlagNotFound,
      errorMessage: `Flag "${key}" is not in the ruleset`,
      prerequisites: [],
    };
  }

  const memo = createSharedMemo();
  const result = evaluateFlag(flag, context, snapshot, memo);
  const prerequisites = (flag.prerequisites ?? []).map((prerequisite) =>
    outcomeOf(prerequisite, snapshot, memo),
  );
  return { ...result, prerequisites };
}

function outcomeOf(
  prerequisite: Prerequisite,
  snapshot: FlagSnapshot,
  memo: SharedPrerequisiteMemo,
): PrerequisiteOutcomeReport {
  const base = { flag: prerequisite.flag, requiredVariants: prerequisite.variants };
  if (!snapshot.flags.has(prerequisite.flag)) return { ...base, status: 'missing' };

  const result = memo.get(prerequisite.flag)?.result;
  if (result === undefined) return { ...base, status: 'not-evaluated' };

  return {
    ...base,
    status: holds(prerequisite, result) ? 'satisfied' : 'failed',
    ...(result.variant === undefined ? {} : { variant: result.variant }),
    reason: result.reason,
    ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
  };
}

/** The evaluator's own rule: enabled, not gated off upstream, and serving a listed variant. */
function holds(prerequisite: Prerequisite, result: EvaluationResult): boolean {
  if (result.errorCode !== undefined || result.variant === undefined) return false;
  if (
    result.reason === EvaluationReason.Disabled ||
    result.reason === EvaluationReason.PrerequisiteFailed
  ) {
    return false;
  }
  return prerequisite.variants.includes(result.variant);
}
