import { isRefetchEvent, SseDataReader } from './sse.js';

export interface ChangeStreamOptions {
  /**
   * An OFREP SSE endpoint. Treated as a credential, as the spec requires: it
   * never appears in an error or a log line.
   */
  readonly url: string | URL;
  readonly headers?: Readonly<Record<string, string>>;
  /** Factor applied to `pollIntervalMs` while the stream is connected. Defaults to 10. */
  readonly pollIntervalMultiplier?: number;
  /** Ceiling of the reconnect backoff. Defaults to 30 s. */
  readonly maxReconnectDelayMs?: number;
  /**
   * Silence after which a connection counts as dead and is reopened. Defaults
   * to 120 s, which the server's 30 s heartbeat keeps well clear of.
   */
  readonly idleTimeoutMs?: number;
}

export interface ChangeStreamListener {
  onConnected(): void;
  onDisconnected(): void;
  onRefetch(): void;
  onError(error: Error): void;
}

export const DEFAULT_POLL_INTERVAL_MULTIPLIER = 10;
export const DEFAULT_MAX_RECONNECT_DELAY_MS = 30_000;
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 120_000;
const BASE_RECONNECT_DELAY_MS = 500;

/** Holds one SSE connection open and reopens it with exponential backoff and jitter. */
export class ChangeStream {
  readonly #url: URL;
  readonly #headers: Readonly<Record<string, string>>;
  readonly #maxDelayMs: number;
  readonly #idleTimeoutMs: number;
  readonly #listener: ChangeStreamListener;

  #stopped = false;
  #running: Promise<void> | undefined;
  #abort: AbortController | undefined;
  #wake: (() => void) | undefined;

  constructor(options: ChangeStreamOptions, listener: ChangeStreamListener) {
    if (!URL.canParse(options.url)) {
      // `new URL` would echo the input in its error.
      throw new TypeError('changeStream.url is not a valid URL');
    }
    this.#url = new URL(options.url);
    this.#headers = options.headers ?? {};
    this.#maxDelayMs = options.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS;
    this.#idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
    this.#listener = listener;
  }

  start(): void {
    this.#running ??= this.#run();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#abort?.abort();
    this.#wake?.();
    await this.#running;
  }

  async #run(): Promise<void> {
    let failures = 0;
    while (!this.#stopped) {
      // oxlint-disable-next-line no-await-in-loop
      failures = (await this.#connect()) ? 0 : failures + 1;
      // oxlint-disable-next-line no-await-in-loop
      if (!this.#stopped) await this.#sleep(reconnectDelay(failures, this.#maxDelayMs));
    }
  }

  /** Resolves `true` when a connection was established, however it ended. */
  async #connect(): Promise<boolean> {
    const abort = new AbortController();
    this.#abort = abort;

    let response: Response;
    try {
      response = await fetch(this.#url, {
        headers: { accept: 'text/event-stream', ...this.#headers },
        signal: abort.signal,
      });
    } catch (error) {
      this.#report('connect failed', error);
      return false;
    }

    if (!response.ok || response.body === null) {
      await response.body?.cancel();
      this.#report(`answered ${response.status}`);
      return false;
    }

    if (this.#stopped) return true;
    this.#listener.onConnected();
    try {
      await this.#consume(response.body, abort);
      this.#report('closed by the server');
    } catch (error) {
      this.#report('disconnected', error);
    }
    if (!this.#stopped) this.#listener.onDisconnected();
    return true;
  }

  async #consume(body: ReadableStream<Uint8Array>, abort: AbortController): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const events = new SseDataReader();
    const onIdle = (): void => {
      abort.abort(new DOMException('No data', 'TimeoutError'));
    };
    let idle = setTimeout(onIdle, this.#idleTimeoutMs);

    try {
      for (;;) {
        // oxlint-disable-next-line no-await-in-loop
        const { done, value } = await reader.read();
        if (done) return;
        clearTimeout(idle);
        idle = setTimeout(onIdle, this.#idleTimeoutMs);
        const completed = events.push(decoder.decode(value, { stream: true }));
        if (completed.some((data) => isRefetchEvent(data))) this.#listener.onRefetch();
      }
    } finally {
      clearTimeout(idle);
    }
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref();
      this.#wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  /** Names the failure without the URL or a raw cause, either of which can carry the URL. */
  #report(what: string, error?: unknown): void {
    if (this.#stopped) return;
    const detail = error === undefined ? '' : ` (${describe(error)})`;
    this.#listener.onError(new Error(`Change stream ${what}${detail}`));
  }
}

/** Exponential with equal jitter: half the step is fixed, half random. */
export function reconnectDelay(failures: number, maxDelayMs: number): number {
  const step = Math.min(maxDelayMs, BASE_RECONNECT_DELAY_MS * 2 ** failures);
  return step / 2 + Math.random() * (step / 2);
}

function describe(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown error';
  const { cause } = error;
  if (typeof cause === 'object' && cause !== null && 'code' in cause) return String(cause.code);
  return error.name;
}
