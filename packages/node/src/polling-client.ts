import {
  createImpressionBatcher,
  DEFAULT_IMPRESSION_FLUSH_INTERVAL_MS,
  FeatureFlagClient,
  type FeatureFlagClientOptions,
  type ImpressionBatcher,
  type ImpressionBatcherStats,
  type ImpressionEvent,
  type ScheduledImpressionOptions,
} from '@kurenwimpel/core';

export interface PollingFlagClientOptions extends FeatureFlagClientOptions {
  /** Interval between background reloads. */
  readonly pollIntervalMs?: number;
  /**
   * Batches and deduplicates the impression feed into `impressions.flush`,
   * every `flushIntervalMs` and on `close()`. Runs alongside `onImpression`.
   */
  readonly impressions?: ScheduledImpressionOptions;
}

export const DEFAULT_POLL_INTERVAL_MS = 30_000;

/**
 * A long-lived client for a Node service.
 *
 * `start()` loads once and then keeps the snapshot fresh on a timer. The
 * timers are unref'd, so they never keep a process alive on their own: a
 * service that finishes its work still exits.
 */
export class PollingFlagClient extends FeatureFlagClient {
  readonly #pollIntervalMs: number;
  readonly #impressions: ImpressionBatcher | undefined;
  readonly #impressionFlushIntervalMs: number;

  #timer: NodeJS.Timeout | undefined;
  #impressionTimer: NodeJS.Timeout | undefined;

  constructor(options: PollingFlagClientOptions) {
    const impressions = batcherFor(options);
    const onImpression = chain(options.onImpression, impressions?.onImpression);
    super(onImpression === undefined ? options : { ...options, onImpression });

    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#impressions = impressions;
    this.#impressionFlushIntervalMs =
      options.impressions?.flushIntervalMs ?? DEFAULT_IMPRESSION_FLUSH_INTERVAL_MS;
  }

  /**
   * Loads the ruleset and starts polling.
   *
   * Rejects if the first load fails: a service that cannot read its flags at
   * startup should crash loudly rather than serve every request on fallbacks.
   */
  async start(): Promise<void> {
    await this.init();

    this.#timer ??= setInterval(() => {
      // refresh() reports its own failures through onError and never rejects.
      void this.refresh();
    }, this.#pollIntervalMs);
    this.#timer.unref();

    const impressions = this.#impressions;
    if (impressions !== undefined) {
      this.#impressionTimer ??= setInterval(() => {
        void impressions.flush();
      }, this.#impressionFlushIntervalMs);
      this.#impressionTimer.unref();
    }
  }

  /** Sends every queued impression now. Never rejects. */
  flushImpressions(): Promise<void> {
    return this.#impressions?.flush() ?? Promise.resolve();
  }

  /** Counts from the impression batcher, or undefined without `impressions`. */
  impressionStats(): ImpressionBatcherStats | undefined {
    return this.#impressions?.stats();
  }

  /** Stops polling, flushes queued impressions and releases the provider. */
  override async close(): Promise<void> {
    clearInterval(this.#timer);
    clearInterval(this.#impressionTimer);
    this.#timer = undefined;
    this.#impressionTimer = undefined;

    await this.#impressions?.close();
    await super.close();
  }
}

function batcherFor(options: PollingFlagClientOptions): ImpressionBatcher | undefined {
  if (options.impressions === undefined) return undefined;

  const { onError, provider } = options;
  return createImpressionBatcher({
    ...options.impressions,
    onError:
      options.impressions.onError ??
      ((error) => onError?.(error, { operation: 'impressionFlush', provider: provider.name })),
  });
}

type ImpressionHook = (event: ImpressionEvent) => void;

function chain(
  first: ImpressionHook | undefined,
  second: ImpressionHook | undefined,
): ImpressionHook | undefined {
  if (first === undefined) return second;
  if (second === undefined) return first;
  return (event) => {
    second(event);
    first(event);
  };
}
