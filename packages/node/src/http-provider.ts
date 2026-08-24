import {
  createSnapshot,
  parseRuleset,
  type FlagParseIssue,
  type FlagProvider,
  type FlagSnapshot,
} from '@kurenwimpel/core';

export interface HttpProviderOptions {
  /** Endpoint returning the ruleset as JSON. */
  readonly url: string | URL;
  readonly headers?: Readonly<Record<string, string>>;
  /** Abort a hanging control plane rather than stalling a refresh forever. */
  readonly timeoutMs?: number;
  /** Injected for tests; defaults to the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  readonly onParseIssues?: (issues: readonly FlagParseIssue[]) => void;
}

export const DEFAULT_HTTP_TIMEOUT_MS = 5_000;

/**
 * Polls an HTTP control plane for the ruleset.
 *
 * Sends `If-None-Match` from the previous snapshot's ETag; a 304 short-circuits
 * to "unchanged" without re-parsing, which is what makes a tight poll interval
 * affordable.
 */
export class HttpFlagProvider implements FlagProvider {
  readonly name = 'http';

  readonly #url: string;
  readonly #headers: Readonly<Record<string, string>>;
  readonly #timeoutMs: number;
  readonly #fetch: typeof globalThis.fetch;
  readonly #onParseIssues: ((issues: readonly FlagParseIssue[]) => void) | undefined;

  constructor(options: HttpProviderOptions) {
    this.#url = String(options.url);
    this.#headers = options.headers ?? {};
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#onParseIssues = options.onParseIssues;
  }

  async load(previous?: FlagSnapshot): Promise<FlagSnapshot | null> {
    const headers: Record<string, string> = { accept: 'application/json', ...this.#headers };
    if (previous?.version !== undefined) headers['if-none-match'] = previous.version;

    const response = await this.#fetch(this.#url, {
      headers,
      signal: AbortSignal.timeout(this.#timeoutMs),
    });

    if (response.status === 304) return null;

    if (!response.ok) {
      throw new Error(`Flag endpoint ${this.#url} responded ${response.status}`);
    }

    const raw: unknown = await response.json();
    const { flags, segments, issues } = parseRuleset(raw);
    if (issues.length > 0) this.#onParseIssues?.(issues);

    const etag = response.headers.get('etag');

    return createSnapshot(flags, etag === null ? {} : { version: etag }, segments);
  }
}
