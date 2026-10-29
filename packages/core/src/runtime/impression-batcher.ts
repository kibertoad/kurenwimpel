/**
 * Batching and deduplication for the impression feed, with no timers: the
 * platform wrappers decide when to call `flush`.
 */

import type { ImpressionEvent } from './impressions.js';

export const DEFAULT_IMPRESSION_MAX_BATCH_SIZE = 500;
export const DEFAULT_IMPRESSION_DEDUP_WINDOW_MS = 60_000;
export const DEFAULT_IMPRESSION_MAX_QUEUE_SIZE = 10_000;
export const DEFAULT_IMPRESSION_MAX_DEDUP_KEYS = 100_000;
export const DEFAULT_IMPRESSION_FLUSH_INTERVAL_MS = 10_000;

/**
 * Options for {@link createImpressionBatcher}. There is deliberately no
 * sampling option: dropping a uniform share of events keeps usage counts
 * proportional but breaks exposure analysis, which needs every subject's first
 * exposure. Use `CountingMetrics` for counts.
 */
export interface ImpressionBatcherOptions {
  /** The sink. Receives at most `maxBatchSize` events per call. */
  readonly flush: (events: ImpressionEvent[]) => Promise<void>;
  /** Queue length that triggers a flush on its own. Default 500. */
  readonly maxBatchSize?: number;
  /**
   * An event is dropped as a repeat when the last one emitted for its
   * `(flagKey, targetingKey)` had the same `variant` and `flagVersion` and is
   * less than this many milliseconds older, by the events' own `timestamp`. A
   * changed variant or version is always emitted, even a flip back to an
   * earlier one. Default 60 000; 0 disables deduplication.
   */
  readonly dedupWindowMs?: number;
  /** Queued events beyond this evict the oldest, counted in `dropped`. Default 10 000. */
  readonly maxQueueSize?: number;
  /**
   * `(flagKey, targetingKey)` pairs remembered for deduplication. Past this the
   * least recently emitted is forgotten, which can only let a repeat through,
   * never hide a change. Default 100 000.
   */
  readonly maxDedupKeys?: number;
  /** Called with a failed batch's error. The batch is dropped, not retried. */
  readonly onError?: (error: Error) => void;
}

/** {@link ImpressionBatcherOptions} plus the interval a platform wrapper flushes on. */
export interface ScheduledImpressionOptions extends ImpressionBatcherOptions {
  /** Default 10 000. */
  readonly flushIntervalMs?: number;
}

/** Event counts since the batcher was created. */
export interface ImpressionBatcherStats {
  /** Events waiting for the next flush. */
  readonly queued: number;
  /** Events handed to a `flush` that resolved. */
  readonly flushed: number;
  /** Events suppressed as repeats within the dedup window. */
  readonly deduplicated: number;
  /** Events evicted by `maxQueueSize` or received after `close()`. */
  readonly dropped: number;
  /** Events in batches whose `flush` rejected. */
  readonly failed: number;
}

export interface ImpressionBatcher {
  /** Pass as the client's `onImpression`. Never throws and never awaits. */
  readonly onImpression: (event: ImpressionEvent) => void;
  /** Sends everything queued, one batch at a time. Never rejects. */
  readonly flush: () => Promise<void>;
  /** Flushes, then drops any later event. */
  readonly close: () => Promise<void>;
  readonly stats: () => ImpressionBatcherStats;
}

export function createImpressionBatcher(options: ImpressionBatcherOptions): ImpressionBatcher {
  const batcher = new Batcher(options);
  return {
    onImpression: (event) => {
      batcher.add(event);
    },
    flush: () => batcher.flush(),
    close: () => batcher.close(),
    stats: () => batcher.stats(),
  };
}

/** What the batcher last emitted for one subject of one flag. */
interface Emitted {
  readonly variant: string | undefined;
  readonly flagVersion: number | undefined;
  readonly at: number;
}

class Batcher {
  readonly #sink: ImpressionBatcherOptions['flush'];
  readonly #onError: ImpressionBatcherOptions['onError'];
  readonly #maxBatchSize: number;
  readonly #dedupWindowMs: number;
  readonly #maxQueueSize: number;
  readonly #maxDedupKeys: number;

  readonly #queue: ImpressionEvent[] = [];
  /** Keyed by `(flagKey, targetingKey)`, in emission order. */
  readonly #lastEmitted = new Map<string, Emitted>();
  #inFlight: Promise<void> | undefined;
  #closed = false;
  #flushed = 0;
  #deduplicated = 0;
  #dropped = 0;
  #failed = 0;

  constructor(options: ImpressionBatcherOptions) {
    this.#sink = options.flush;
    this.#onError = options.onError;
    this.#maxBatchSize = Math.max(1, options.maxBatchSize ?? DEFAULT_IMPRESSION_MAX_BATCH_SIZE);
    this.#dedupWindowMs = options.dedupWindowMs ?? DEFAULT_IMPRESSION_DEDUP_WINDOW_MS;
    this.#maxQueueSize = Math.max(1, options.maxQueueSize ?? DEFAULT_IMPRESSION_MAX_QUEUE_SIZE);
    this.#maxDedupKeys = Math.max(1, options.maxDedupKeys ?? DEFAULT_IMPRESSION_MAX_DEDUP_KEYS);
  }

  add(event: ImpressionEvent): void {
    if (this.#closed) {
      this.#dropped += 1;
      return;
    }
    if (this.#isRepeat(event)) {
      this.#deduplicated += 1;
      return;
    }

    if (this.#queue.length >= this.#maxQueueSize) {
      this.#queue.shift();
      this.#dropped += 1;
    }
    this.#queue.push(event);

    if (this.#queue.length >= this.#maxBatchSize) void this.flush();
  }

  #isRepeat(event: ImpressionEvent): boolean {
    if (this.#dedupWindowMs <= 0) return false;

    const now = event.timestamp;
    this.#forgetExpired(now);

    // Compared against the subject's latest emission rather than looked up by
    // the full tuple, so a flip back to an earlier variant is emitted too.
    const key = JSON.stringify([event.flagKey, event.targetingKey]);
    const last = this.#lastEmitted.get(key);
    if (
      last !== undefined &&
      last.variant === event.variant &&
      last.flagVersion === event.flagVersion &&
      now - last.at < this.#dedupWindowMs
    ) {
      return true;
    }

    // Re-inserted so that the map stays ordered by emission time.
    this.#lastEmitted.delete(key);
    this.#lastEmitted.set(key, { variant: event.variant, flagVersion: event.flagVersion, at: now });
    if (this.#lastEmitted.size > this.#maxDedupKeys) this.#forgetOldest();
    return false;
  }

  #forgetExpired(now: number): void {
    for (const [key, { at }] of this.#lastEmitted) {
      if (now - at < this.#dedupWindowMs) return;
      this.#lastEmitted.delete(key);
    }
  }

  #forgetOldest(): void {
    const oldest = this.#lastEmitted.keys().next();
    if (oldest.done !== true) this.#lastEmitted.delete(oldest.value);
  }

  flush(): Promise<void> {
    this.#inFlight ??= this.#drain().finally(() => {
      this.#inFlight = undefined;
    });
    return this.#inFlight;
  }

  async #drain(): Promise<void> {
    while (this.#queue.length > 0) {
      const batch = this.#queue.splice(0, this.#maxBatchSize);
      try {
        // Sequential on purpose: a slow sink sees one batch at a time, not a burst.
        // oxlint-disable-next-line no-await-in-loop
        await this.#sink(batch);
        this.#flushed += batch.length;
      } catch (error) {
        this.#failed += batch.length;
        this.#report(error);
      }
    }
  }

  #report(error: unknown): void {
    try {
      this.#onError?.(error instanceof Error ? error : new Error(String(error)));
    } catch {
      // A throwing error hook must not stop the drain or reject a flush.
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.flush();
  }

  stats(): ImpressionBatcherStats {
    return {
      queued: this.#queue.length,
      flushed: this.#flushed,
      deduplicated: this.#deduplicated,
      dropped: this.#dropped,
      failed: this.#failed,
    };
  }
}
