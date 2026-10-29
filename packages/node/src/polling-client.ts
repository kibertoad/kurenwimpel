import {
  FeatureFlagClient,
  type ClientErrorInfo,
  type EvaluationContext,
  type FlagProvider,
  type ImpressionEvent,
} from '@kurenwimpel/core';

import {
  ChangeStream,
  DEFAULT_POLL_INTERVAL_MULTIPLIER,
  type ChangeStreamOptions,
} from './change-stream.js';

/** `operation: 'stream'` reports a change-stream connection that failed or dropped. */
export type PollingClientErrorInfo =
  | ClientErrorInfo
  | { readonly operation: 'stream'; readonly provider: string };

export interface PollingFlagClientOptions {
  readonly provider: FlagProvider;
  /** Interval between background reloads. */
  readonly pollIntervalMs?: number;
  readonly defaultContext?: EvaluationContext;
  readonly onError?: (error: Error, info: PollingClientErrorInfo) => void;
  /** The exposure feed for experiment analysis; one event per evaluation. */
  readonly onImpression?: (event: ImpressionEvent) => void;
  /**
   * An OFREP event stream to refresh on. While it is connected, polling slows
   * by `pollIntervalMultiplier`; when it drops, polling returns to normal.
   */
  readonly changeStream?: ChangeStreamOptions;
}

export const DEFAULT_POLL_INTERVAL_MS = 30_000;

/**
 * A long-lived client for a Node service.
 *
 * `start()` loads once and then keeps the snapshot fresh on a timer. The timer
 * is unref'd, so it never keeps a process alive on its own: a service that
 * finishes its work still exits. An open change stream is a live socket and
 * does hold the process until `close()`.
 */
export class PollingFlagClient extends FeatureFlagClient {
  readonly #pollIntervalMs: number;
  readonly #stream: ChangeStream | undefined;

  #timer: NodeJS.Timeout | undefined;

  constructor(options: PollingFlagClientOptions) {
    super({
      provider: options.provider,
      ...(options.defaultContext === undefined ? {} : { defaultContext: options.defaultContext }),
      ...(options.onError === undefined ? {} : { onError: options.onError }),
      ...(options.onImpression === undefined ? {} : { onImpression: options.onImpression }),
    });

    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#stream = this.#createStream(options);
  }

  /**
   * Loads the ruleset and starts polling, and the change stream when one is
   * configured.
   *
   * Rejects if the first load fails: a service that cannot read its flags at
   * startup should crash loudly rather than serve every request on fallbacks.
   */
  async start(): Promise<void> {
    await this.init();

    if (this.#timer === undefined) this.#poll(this.#pollIntervalMs);
    this.#stream?.start();
  }

  /** Stops polling and the change stream, and releases the provider. */
  override async close(): Promise<void> {
    await this.#stream?.stop();
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }

    await super.close();
  }

  #poll(intervalMs: number): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = setInterval(() => {
      // refresh() reports its own failures through onError and never rejects.
      void this.refresh();
    }, intervalMs);
    this.#timer.unref();
  }

  #createStream(options: PollingFlagClientOptions): ChangeStream | undefined {
    const { changeStream, onError } = options;
    if (changeStream === undefined) return undefined;

    const multiplier = changeStream.pollIntervalMultiplier ?? DEFAULT_POLL_INTERVAL_MULTIPLIER;
    return new ChangeStream(changeStream, {
      onConnected: () => {
        this.#poll(this.#pollIntervalMs * multiplier);
        // Changes made while the stream was down sent no event.
        void this.refresh();
      },
      onDisconnected: () => {
        this.#poll(this.#pollIntervalMs);
      },
      onRefetch: () => {
        void this.refresh();
      },
      onError: (error) => {
        onError?.(error, { operation: 'stream', provider: this.providerName });
      },
    });
  }
}
