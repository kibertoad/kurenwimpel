import {
  FeatureFlagClient,
  type ClientErrorInfo,
  type EvaluationContext,
  type FlagProvider,
  type ImpressionEvent,
} from '@kurenwimpel/core';

export interface PollingFlagClientOptions {
  readonly provider: FlagProvider;
  /** Interval between background reloads. */
  readonly pollIntervalMs?: number;
  readonly defaultContext?: EvaluationContext;
  readonly onError?: (error: Error, info: ClientErrorInfo) => void;
  /** The exposure feed for experiment analysis; one event per evaluation. */
  readonly onImpression?: (event: ImpressionEvent) => void;
}

export const DEFAULT_POLL_INTERVAL_MS = 30_000;

/**
 * A long-lived client for a Node service.
 *
 * `start()` loads once and then keeps the snapshot fresh on a timer. The timer
 * is unref'd, so it never keeps a process alive on its own — a service that
 * finishes its work still exits.
 */
export class PollingFlagClient extends FeatureFlagClient {
  readonly #pollIntervalMs: number;

  #timer: NodeJS.Timeout | undefined;

  constructor(options: PollingFlagClientOptions) {
    super({
      provider: options.provider,
      ...(options.defaultContext === undefined ? {} : { defaultContext: options.defaultContext }),
      ...(options.onError === undefined ? {} : { onError: options.onError }),
      ...(options.onImpression === undefined ? {} : { onImpression: options.onImpression }),
    });

    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
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
  }

  /** Stops polling and releases the provider. */
  override async close(): Promise<void> {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }

    await super.close();
  }
}
