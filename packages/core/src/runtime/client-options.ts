import type { EvaluationContext } from '../model/context.js';
import type { ImpressionEvent } from './impressions.js';
import type { MetricsSink } from './metrics.js';
import type { FlagProvider } from './provider.js';
import type { FlagSnapshot } from './snapshot.js';

export interface ClientErrorInfo {
  readonly operation:
    | 'load'
    | 'close'
    | 'impression'
    | 'store'
    | 'metrics'
    | 'snapshotChange'
    | 'listener';
  readonly provider: string;
}

/** Knobs for {@link FeatureFlagClient.evaluateAll}. */
export interface BulkEvaluationOptions {
  /**
   * Emit an impression per flag. Off by default: a bulk fetch is not an
   * exposure, and counting it as one makes every experiment's exposed
   * population "everyone who loaded the page".
   */
  readonly impressions?: boolean;
}

export interface FeatureFlagClientOptions {
  readonly provider: FlagProvider;
  /**
   * Attributes merged under every per-call context: service name, region,
   * deployment stage. A per-call attribute wins on conflict; passing it as
   * `undefined` clears the default for that one call, and leaving it out
   * inherits the default.
   */
  readonly defaultContext?: EvaluationContext;
  /**
   * Called when a background refresh fails. Refresh errors are never thrown at
   * evaluation sites, because a stale snapshot beats a failed request.
   */
  readonly onError?: (error: Error, info: ClientErrorInfo) => void;
  /**
   * Called once per evaluation with the served outcome. This is the exposure
   * feed for experiment analysis; a throwing hook is reported through
   * `onError` and never fails the evaluation.
   */
  readonly onImpression?: (event: ImpressionEvent) => void;
  /**
   * Called after a new snapshot replaces the served one, with `previous`
   * undefined on the first install. Not called on an "unchanged" answer. A
   * throwing hook is reported through `onError`.
   */
  readonly onSnapshotChange?: (snapshot: FlagSnapshot, previous: FlagSnapshot | undefined) => void;
  /** Counts every evaluation without building an event; see {@link MetricsSink}. */
  readonly metrics?: MetricsSink;
}
