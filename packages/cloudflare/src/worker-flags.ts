import {
  FeatureFlagClient,
  snapshotFromRuleset,
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

  #initPromise: Promise<void> | undefined;
  #lastLoadedAt = 0;
  #retryAt = 0;
  #initError: unknown;
  #refreshInFlight: Promise<void> | undefined;

  constructor(options: WorkerFlagsOptions) {
    this.#refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
    this.#retryAfterMs = options.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS;
    this.#onInitFailure = options.onInitFailure ?? 'serve-defaults';
    this.#bootstrap = options.bootstrap;
    this.#onError = options.onError;
    this.#client = new FeatureFlagClient({
      provider: options.provider,
      ...(options.defaultContext === undefined ? {} : { defaultContext: options.defaultContext }),
      ...(options.onError === undefined ? {} : { onError: options.onError }),
      ...(options.onImpression === undefined ? {} : { onImpression: options.onImpression }),
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
