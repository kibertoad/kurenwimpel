import {
  createImpressionBatcher,
  DEFAULT_IMPRESSION_FLUSH_INTERVAL_MS,
  FeatureFlagClient,
  snapshotFromRuleset,
  type EvaluationContext,
  type FlagProvider,
  type ImpressionBatcher,
  type ImpressionBatcherStats,
  type ImpressionEvent,
  type ScheduledImpressionOptions,
} from '@kurenwimpel/core';

export interface WorkerFlagsOptions {
  readonly provider: FlagProvider;
  /**
   * How stale a snapshot may get before the next request triggers a background
   * refresh. Refreshes never block the request they were scheduled from.
   */
  readonly refreshIntervalMs?: number;
  readonly defaultContext?: EvaluationContext;
  readonly onError?: (error: Error) => void;
  /** The exposure feed for experiment analysis; one event per evaluation. */
  readonly onImpression?: (event: ImpressionEvent) => void;
  /**
   * What `get()` does when the cold load fails and there is no `bootstrap`.
   * `'serve-defaults'` resolves to the not-ready client, whose getters return
   * the caller's default; `'throw'` rejects with the load error.
   */
  readonly onInitFailure?: InitFailureMode;
  /**
   * How long to wait after a failed load before the next request tries again.
   * Also the refresh interval while a fallback snapshot is being served.
   */
  readonly retryAfterMs?: number;
  /** A raw ruleset to serve, marked `origin: 'fallback'`, when the cold load fails. */
  readonly bootstrap?: unknown;
  /**
   * Batches and deduplicates the impression feed into `impressions.flush`.
   * Timers do not run between requests, so `get(ctx)` hands a flush to
   * `ctx.waitUntil` once events are queued and `flushIntervalMs` has passed
   * since the last one. Runs alongside `onImpression`; a failed batch goes to
   * `impressions.onError`, or else `onError`.
   */
  readonly impressions?: ScheduledImpressionOptions;
}

export type InitFailureMode = 'serve-defaults' | 'throw';

export const DEFAULT_REFRESH_INTERVAL_MS = 60_000;
export const DEFAULT_RETRY_AFTER_MS = 5000;

/**
 * An isolate-scoped feature flag client for Workers.
 *
 * Hold one of these at module scope. Isolates are reused across requests, so
 * the ruleset is fetched once on the first request an isolate serves and then
 * refreshed out of band via `ctx.waitUntil`. Request latency only ever pays
 * for the first load, and a failed one is retried at most once per
 * `retryAfterMs`.
 */
export class WorkerFlags {
  readonly #client: FeatureFlagClient;
  readonly #refreshIntervalMs: number;
  readonly #retryAfterMs: number;
  readonly #onInitFailure: InitFailureMode;
  readonly #bootstrap: unknown;
  readonly #onError: ((error: Error) => void) | undefined;
  readonly #impressions: ImpressionBatcher | undefined;
  readonly #impressionFlushIntervalMs: number;

  #initPromise: Promise<void> | undefined;
  #lastLoadedAt = 0;
  #retryAt = 0;
  #initError: unknown;
  #refreshInFlight: Promise<void> | undefined;
  #lastImpressionFlushAt = Date.now();

  constructor(options: WorkerFlagsOptions) {
    this.#refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
    this.#retryAfterMs = options.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS;
    this.#onInitFailure = options.onInitFailure ?? 'serve-defaults';
    this.#bootstrap = options.bootstrap;
    this.#onError = options.onError;
    this.#impressions = batcherFor(options);
    this.#impressionFlushIntervalMs =
      options.impressions?.flushIntervalMs ?? DEFAULT_IMPRESSION_FLUSH_INTERVAL_MS;
    const onImpression = chain(options.onImpression, this.#impressions?.onImpression);
    this.#client = new FeatureFlagClient({
      provider: options.provider,
      ...(options.defaultContext === undefined ? {} : { defaultContext: options.defaultContext }),
      ...(options.onError === undefined ? {} : { onError: options.onError }),
      ...(onImpression === undefined ? {} : { onImpression }),
    });
  }

  /**
   * Returns the client.
   *
   * Awaits the initial load on a cold isolate. If that load fails, resolves to
   * the bootstrap or the not-ready client (or rejects, under `'throw'`) without
   * trying again until `retryAfterMs` has passed. Once warm it resolves without
   * I/O and, when the snapshot is due a refresh, hands the reload to
   * `ctx.waitUntil` so it outlives the response.
   */
  async get(ctx?: Pick<ExecutionContext, 'waitUntil'>): Promise<FeatureFlagClient> {
    await this.#scheduleImpressionFlush(ctx);

    if (!this.#client.ready) {
      if (Date.now() < this.#retryAt) return this.#notReady();
      // Concurrent requests on a cold isolate share one load.
      this.#initPromise ??= this.#initialise();
      await this.#initPromise;
      return this.#client.ready ? this.#client : this.#notReady();
    }

    if (Date.now() - this.#lastLoadedAt >= this.#currentIntervalMs()) {
      const refresh = this.#refresh();
      if (ctx === undefined) await refresh;
      else ctx.waitUntil(refresh);
    }

    return this.#client;
  }

  /**
   * Sends every queued impression now. For a `scheduled` handler, or a
   * `ctx.waitUntil` at the end of a request that must not wait for the next
   * `get()`. Never rejects.
   */
  flushImpressions(): Promise<void> {
    this.#lastImpressionFlushAt = Date.now();
    return this.#impressions?.flush() ?? Promise.resolve();
  }

  /** Counts from the impression batcher, or undefined without `impressions`. */
  impressionStats(): ImpressionBatcherStats | undefined {
    return this.#impressions?.stats();
  }

  /** Awaited only when there is no `ctx` to hand the flush to, as a refresh is. */
  async #scheduleImpressionFlush(
    ctx: Pick<ExecutionContext, 'waitUntil'> | undefined,
  ): Promise<void> {
    if (this.#impressions === undefined || this.#impressions.stats().queued === 0) return;
    if (Date.now() - this.#lastImpressionFlushAt < this.#impressionFlushIntervalMs) return;

    const flush = this.flushImpressions();
    if (ctx === undefined) await flush;
    else ctx.waitUntil(flush);
  }

  /** The client as-is, ready or not. For call sites that cannot await. */
  get client(): FeatureFlagClient {
    return this.#client;
  }

  #notReady(): FeatureFlagClient {
    if (this.#onInitFailure === 'throw') throw this.#initError;
    return this.#client;
  }

  #currentIntervalMs(): number {
    return this.#client.snapshot.origin === 'fallback'
      ? this.#retryAfterMs
      : this.#refreshIntervalMs;
  }

  async #initialise(): Promise<void> {
    try {
      await this.#client.init();
      this.#lastLoadedAt = Date.now();
    } catch (error) {
      this.#initError = error;
      this.#retryAt = Date.now() + this.#retryAfterMs;
      this.#onError?.(error instanceof Error ? error : new Error(String(error)));
      this.#installBootstrap();
    } finally {
      this.#initPromise = undefined;
    }
  }

  #installBootstrap(): void {
    if (this.#bootstrap === undefined) return;
    this.#client.setSnapshot(snapshotFromRuleset(this.#bootstrap, { origin: 'fallback' }));
    this.#lastLoadedAt = Date.now();
  }

  #refresh(): Promise<void> {
    // Stamp before awaiting so a burst of requests schedules only one reload.
    this.#lastLoadedAt = Date.now();
    this.#refreshInFlight ??= this.#runRefresh();

    return this.#refreshInFlight;
  }

  async #runRefresh(): Promise<void> {
    try {
      // refresh() reports its own failures through onError and never rejects.
      await this.#client.refresh();
    } finally {
      this.#refreshInFlight = undefined;
    }
  }
}

function batcherFor(options: WorkerFlagsOptions): ImpressionBatcher | undefined {
  if (options.impressions === undefined) return undefined;
  const onError = options.impressions.onError ?? options.onError;
  return createImpressionBatcher({
    ...options.impressions,
    ...(onError === undefined ? {} : { onError }),
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
