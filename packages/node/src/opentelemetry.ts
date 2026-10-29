/**
 * OpenTelemetry metrics for a flag client. Import from
 * `@kurenwimpel/node/opentelemetry`; the main entry never loads `@opentelemetry/api`.
 */

import type {
  ClientStatus,
  EvaluationErrorCode,
  EvaluationReason,
  MetricsSink,
} from '@kurenwimpel/core';
import type {
  Attributes,
  BatchObservableResult,
  Counter,
  Meter,
  ObservableCounter,
  ObservableGauge,
} from '@opentelemetry/api';

/** The slice of a client the observable instruments read. */
export interface StatusSource {
  readonly providerName: string;
  status(): ClientStatus;
}

interface CachedAttributes {
  readonly variant: string | undefined;
  readonly reason: EvaluationReason;
  readonly errorCode: EvaluationErrorCode | undefined;
  readonly attributes: Attributes;
}

/**
 * A {@link MetricsSink} that feeds `flag.evaluations`, plus `observe()` for
 * `flag.snapshot.age` and `flag.load.failures`. Attribute names follow the
 * OpenTelemetry feature-flag semantic conventions.
 */
export class OpenTelemetryMetrics implements MetricsSink {
  readonly #meter: Meter;
  readonly #evaluations: Counter;
  readonly #snapshotAge: ObservableGauge;
  readonly #loadFailures: ObservableCounter;
  readonly #attributes = new Map<string, CachedAttributes[]>();

  constructor(meter: Meter) {
    this.#meter = meter;
    this.#evaluations = meter.createCounter('flag.evaluations', {
      description: 'Flag evaluations served, by flag, variant, reason and error.',
      unit: '{evaluation}',
    });
    this.#snapshotAge = meter.createObservableGauge('flag.snapshot.age', {
      description: 'Seconds since the last load that installed or confirmed the served snapshot.',
      unit: 's',
    });
    this.#loadFailures = meter.createObservableCounter('flag.load.failures', {
      description: 'Failed loads, including boots from a last-known-good copy.',
      unit: '{failure}',
    });
  }

  record(
    flagKey: string,
    variant: string | undefined,
    reason: EvaluationReason,
    errorCode?: EvaluationErrorCode,
  ): void {
    this.#evaluations.add(1, this.#attributesFor(flagKey, variant, reason, errorCode));
  }

  /**
   * Reports the client's snapshot age and load failures on every collection,
   * tagged with its provider name. Returns a function that stops observing.
   */
  observe(client: StatusSource): () => void {
    const attributes: Attributes = { 'feature_flag.provider.name': client.providerName };
    const callback = (result: BatchObservableResult): void => {
      const status = client.status();
      if (status.lastSuccessfulLoadAt !== undefined) {
        const ageSeconds = (Date.now() - status.lastSuccessfulLoadAt) / 1000;
        result.observe(this.#snapshotAge, ageSeconds, attributes);
      }
      result.observe(this.#loadFailures, status.totalLoadFailures, attributes);
    };
    const observables = [this.#snapshotAge, this.#loadFailures];

    this.#meter.addBatchObservableCallback(callback, observables);
    return () => {
      this.#meter.removeBatchObservableCallback(callback, observables);
    };
  }

  /** Built once per combination, so recording does not allocate an attributes object per call. */
  #attributesFor(
    flagKey: string,
    variant: string | undefined,
    reason: EvaluationReason,
    errorCode: EvaluationErrorCode | undefined,
  ): Attributes {
    let rows = this.#attributes.get(flagKey);
    if (rows === undefined) {
      rows = [];
      this.#attributes.set(flagKey, rows);
    }

    for (const row of rows) {
      if (row.variant === variant && row.reason === reason && row.errorCode === errorCode) {
        return row.attributes;
      }
    }

    const attributes = semconvAttributes(flagKey, variant, reason, errorCode);
    rows.push({ variant, reason, errorCode, attributes });
    return attributes;
  }
}

function semconvAttributes(
  flagKey: string,
  variant: string | undefined,
  reason: EvaluationReason,
  errorCode: EvaluationErrorCode | undefined,
): Attributes {
  return {
    'feature_flag.key': flagKey,
    'feature_flag.result.reason': reason.toLowerCase(),
    ...(variant === undefined ? {} : { 'feature_flag.result.variant': variant }),
    ...(errorCode === undefined ? {} : { 'error.type': errorCode.toLowerCase() }),
  };
}
