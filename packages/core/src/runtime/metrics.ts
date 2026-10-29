/**
 * Evaluation metrics: a counter-shaped feed of what the client served, cheaper
 * than `onImpression` because no event object is built per evaluation.
 */

import type { EvaluationErrorCode, EvaluationReason } from '../model/result.js';

/**
 * Receives one call per evaluation the client answers, including each flag of
 * `evaluateAll`. Called synchronously on the evaluation path, so it should do
 * no more than bump a counter. A throwing sink is reported through `onError`
 * with operation `metrics` and never fails the evaluation.
 */
export interface MetricsSink {
  record(
    flagKey: string,
    variant: string | undefined,
    reason: EvaluationReason,
    errorCode?: EvaluationErrorCode,
  ): void;
}

/** One row of {@link CountingMetrics.collect}. */
export interface EvaluationCount {
  readonly flagKey: string;
  readonly variant: string | undefined;
  readonly reason: EvaluationReason;
  readonly errorCode: EvaluationErrorCode | undefined;
  readonly count: number;
}

interface MutableCount {
  readonly variant: string | undefined;
  readonly reason: EvaluationReason;
  readonly errorCode: EvaluationErrorCode | undefined;
  count: number;
}

/**
 * An in-memory {@link MetricsSink} counting evaluations per flag key, variant,
 * reason and error code. A combination allocates once, when first seen in a
 * collection window; every later `record` of it only increments.
 */
export class CountingMetrics implements MetricsSink {
  #counts = new Map<string, MutableCount[]>();

  record(
    flagKey: string,
    variant: string | undefined,
    reason: EvaluationReason,
    errorCode?: EvaluationErrorCode,
  ): void {
    let rows = this.#counts.get(flagKey);
    if (rows === undefined) {
      rows = [];
      this.#counts.set(flagKey, rows);
    }

    for (const row of rows) {
      if (row.variant === variant && row.reason === reason && row.errorCode === errorCode) {
        row.count += 1;
        return;
      }
    }
    rows.push({ variant, reason, errorCode, count: 1 });
  }

  /** Returns the counts since the previous `collect` and starts a new window. */
  collect(): EvaluationCount[] {
    const counts = this.#counts;
    this.#counts = new Map();

    const collected: EvaluationCount[] = [];
    for (const [flagKey, rows] of counts) {
      for (const row of rows) collected.push({ flagKey, ...row });
    }
    return collected;
  }
}
