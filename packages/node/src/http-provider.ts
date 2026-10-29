import {
  loadWithFallback,
  snapshotFromRuleset,
  type FlagParseIssue,
  type FlagProvider,
  type FlagSnapshot,
  type LastKnownGoodStore,
  type ProviderLoadContext,
  type RulesetSourceOptions,
} from '@kurenwimpel/core';

import { assertMaxBytes, DEFAULT_HTTP_MAX_BYTES, readCapped } from './read-capped.js';

export interface HttpProviderOptions {
  /** Endpoint returning the ruleset as JSON. */
  readonly url: string | URL;
  /**
   * Sent on every request. Credentials belong here, as `authorization: Bearer ...`,
   * never in `url`: the URL is quoted in load errors and lands in access logs.
   */
  readonly headers?: Readonly<Record<string, string>>;
  /** Abort a hanging control plane rather than stalling a refresh forever. */
  readonly timeoutMs?: number;
  /** Injected for tests; defaults to the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  readonly onParseIssues?: (issues: readonly FlagParseIssue[]) => void;
  /** Where to keep the last ruleset that loaded, to boot from when the endpoint is down. */
  readonly lastKnownGood?: LastKnownGoodStore;
  /**
   * Largest response body accepted, in bytes. A bigger one fails the load
   * before it is parsed: rejected up front when `Content-Length` says so, and
   * otherwise as soon as the body read passes the limit. Defaults to 10 MiB.
   */
  readonly maxBytes?: number;
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
  readonly #lastKnownGood: LastKnownGoodStore | undefined;
  readonly #maxBytes: number;

  constructor(options: HttpProviderOptions) {
    this.#url = String(options.url);
    this.#headers = options.headers ?? {};
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#onParseIssues = options.onParseIssues;
    this.#lastKnownGood = options.lastKnownGood;
    this.#maxBytes = assertMaxBytes(options.maxBytes ?? DEFAULT_HTTP_MAX_BYTES);
  }

  load(previous?: FlagSnapshot, context?: ProviderLoadContext): Promise<FlagSnapshot | null> {
    const source: RulesetSourceOptions = {
      lastKnownGood: this.#lastKnownGood,
      onParseIssues: this.#onParseIssues,
      context,
    };
    return loadWithFallback(previous, () => this.#fetchRuleset(previous, source), source);
  }

  async #fetchRuleset(
    previous: FlagSnapshot | undefined,
    source: RulesetSourceOptions,
  ): Promise<FlagSnapshot | null> {
    const headers: Record<string, string> = { accept: 'application/json', ...this.#headers };
    if (previous?.version !== undefined) headers['if-none-match'] = previous.version;

    const response = await this.#fetch(this.#url, {
      headers,
      signal: AbortSignal.timeout(this.#timeoutMs),
    });

    if (response.status === 304) {
      // A 304 carries no ruleset, so it is only usable as "keep serving what
      // you already have" — and on the first load there is nothing to keep.
      // The test is therefore whether a snapshot exists at all, not whether
      // this request carried a validator. Keying it off the validator turned
      // every 304 into a failure for a healthy client whose control plane had
      // simply stopped stamping ETags: it holds a perfectly good snapshot,
      // sends no `If-None-Match`, and a caching proxy answers 304 anyway — so
      // it reported an error through `onError` on every poll, forever, while
      // serving exactly the right flags.
      if (previous === undefined) {
        throw new Error(`Flag endpoint ${this.#url} responded 304 to an unconditional request`);
      }
      return null;
    }

    if (!response.ok) {
      throw new Error(`Flag endpoint ${this.#url} responded ${response.status}`);
    }

    const raw: unknown = JSON.parse(await this.#readBody(response));
    const etag = response.headers.get('etag');

    return snapshotFromRuleset(raw, etag === null ? {} : { version: etag }, source);
  }

  async #readBody(response: Response): Promise<string> {
    const tooLarge = (): Error =>
      new Error(`Flag endpoint ${this.#url} sent more than maxBytes (${this.#maxBytes} bytes)`);

    const declared = Number(response.headers.get('content-length') ?? Number.NaN);
    if (declared > this.#maxBytes) {
      await response.body?.cancel();
      throw tooLarge();
    }
    // Checked again while reading: the header can be absent, wrong, or count
    // the compressed bytes of a body that decompresses to far more.
    return readCapped(response.body, this.#maxBytes, tooLarge);
  }
}
