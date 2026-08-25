import {
  FeatureFlagClient,
  type EvaluationContext,
  type FlagProvider,
  type ImpressionEvent,
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
}

export const DEFAULT_REFRESH_INTERVAL_MS = 60_000;

/**
 * An isolate-scoped feature flag client for Workers.
 *
 * Hold one of these at module scope. Isolates are reused across requests, so
 * the ruleset is fetched once on the first request an isolate serves and then
 * refreshed out of band via `ctx.waitUntil` — request latency only ever pays
 * for the very first load.
 */
export class WorkerFlags {
  readonly #client: FeatureFlagClient;
  readonly #refreshIntervalMs: number;
  readonly #onError: ((error: Error) => void) | undefined;

  #initPromise: Promise<void> | undefined;
  #lastLoadedAt = 0;
  #refreshInFlight: Promise<void> | undefined;

  constructor(options: WorkerFlagsOptions) {
    this.#refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
    this.#onError = options.onError;
    this.#client = new FeatureFlagClient({
      provider: options.provider,
      ...(options.defaultContext === undefined ? {} : { defaultContext: options.defaultContext }),
      ...(options.onError === undefined ? {} : { onError: options.onError }),
      ...(options.onImpression === undefined ? {} : { onImpression: options.onImpression }),
    });
  }

  /**
   * Returns a ready client.
   *
   * Awaits the initial load on a cold isolate. Once warm it resolves without
   * I/O and, when the snapshot has aged past the refresh interval, hands the
   * reload to `ctx.waitUntil` so it outlives the response.
   */
  async get(ctx?: Pick<ExecutionContext, 'waitUntil'>): Promise<FeatureFlagClient> {
    if (!this.#client.ready) {
      // Concurrent requests on a cold isolate share one load.
      this.#initPromise ??= this.#initialise();
      await this.#initPromise;
      return this.#client;
    }

    if (Date.now() - this.#lastLoadedAt >= this.#refreshIntervalMs) {
      const refresh = this.#refresh();
      if (ctx === undefined) await refresh;
      else ctx.waitUntil(refresh);
    }

    return this.#client;
  }

  /** The client as-is, ready or not. For call sites that cannot await. */
  get client(): FeatureFlagClient {
    return this.#client;
  }

  async #initialise(): Promise<void> {
    try {
      await this.#client.init();
      this.#lastLoadedAt = Date.now();
    } catch (error) {
      // Let the next request retry rather than pinning a cold isolate to a
      // permanently failed load.
      this.#initPromise = undefined;
      this.#onError?.(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
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
