/**
 * Load health: what `FeatureFlagClient.status()` reports about freshness and
 * failures, tracked apart from the client so the evaluation code stays small.
 */

import type { FlagSnapshot, SnapshotOrigin } from './snapshot.js';

export interface ClientStatus {
  /** True once a snapshot has been installed. */
  readonly ready: boolean;
  /** The served snapshot's origin; `undefined` before the first install. */
  readonly origin: SnapshotOrigin | undefined;
  readonly snapshotVersion: string | undefined;
  /** The served snapshot's `fetchedAt`, epoch millis. Does not move on an "unchanged" answer. */
  readonly snapshotBuiltAt: number | undefined;
  /**
   * Epoch millis of the last load that installed a live snapshot or confirmed
   * the current one unchanged. This is the freshness signal to alert on.
   */
  readonly lastSuccessfulLoadAt: number | undefined;
  /** Epoch millis of the last load that failed or fell back to a last-known-good copy. */
  readonly lastFailedLoadAt: number | undefined;
  /** Failed loads since the last successful one. */
  readonly consecutiveFailures: number;
  /** Failed loads over the client's lifetime. Only grows, so it can back a counter. */
  readonly totalLoadFailures: number;
  /** Parse issues the provider reported for the served snapshot; 0 when it reports none. */
  readonly lastParseIssueCount: number;
}

export type LoadResult = 'installed' | 'unchanged' | 'failed';

/** Mutable counters behind {@link ClientStatus}. */
export class LoadHealth {
  #lastSuccessAt: number | undefined;
  #lastFailureAt: number | undefined;
  #consecutiveFailures = 0;
  #totalFailures = 0;
  #parseIssues = 0;
  #pendingParseIssues: number | undefined;

  /** Called when a load starts, so issues reported during it can be told apart from older ones. */
  startLoad(): void {
    this.#pendingParseIssues = undefined;
  }

  addParseIssues(count: number): void {
    this.#pendingParseIssues = (this.#pendingParseIssues ?? 0) + count;
  }

  /** A fallback snapshot counts as a failure: the live source did not answer. */
  finishLoad(result: LoadResult, origin: SnapshotOrigin): void {
    if (result === 'installed' && this.#pendingParseIssues !== undefined) {
      this.#parseIssues = this.#pendingParseIssues;
    }
    this.#pendingParseIssues = undefined;

    if (result === 'failed' || (result === 'installed' && origin === 'fallback')) {
      this.#lastFailureAt = Date.now();
      this.#consecutiveFailures += 1;
      this.#totalFailures += 1;
      return;
    }
    this.markSuccess();
  }

  markSuccess(): void {
    this.#lastSuccessAt = Date.now();
    this.#consecutiveFailures = 0;
  }

  status(snapshot: FlagSnapshot, ready: boolean): ClientStatus {
    return {
      ready,
      origin: ready ? snapshot.origin : undefined,
      snapshotVersion: ready ? snapshot.version : undefined,
      snapshotBuiltAt: ready ? snapshot.fetchedAt : undefined,
      lastSuccessfulLoadAt: this.#lastSuccessAt,
      lastFailedLoadAt: this.#lastFailureAt,
      consecutiveFailures: this.#consecutiveFailures,
      totalLoadFailures: this.#totalFailures,
      lastParseIssueCount: this.#parseIssues,
    };
  }
}
