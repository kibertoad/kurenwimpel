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

import { assertMaxBytes, DEFAULT_KV_MAX_BYTES, readCapped } from './read-capped.js';

export interface KvProviderOptions {
  /** The KV namespace binding holding the ruleset. */
  readonly namespace: KVNamespace;
  /** Key the ruleset JSON lives under. */
  readonly key?: string;
  /**
   * Seconds Workers KV may serve this value from the colo edge cache.
   *
   * KV reads are eventually consistent anyway, so this trades flag propagation
   * delay for read latency and cost. Zero disables the edge cache.
   */
  readonly cacheTtlSeconds?: number;
  /** Called for definitions that failed validation; the rest still load. */
  readonly onParseIssues?: (issues: readonly FlagParseIssue[]) => void;
  /** Where to keep the last ruleset that loaded, to boot from when KV is unreachable. */
  readonly lastKnownGood?: LastKnownGoodStore;
  /**
   * How long a KV read may take before the load fails. KV's `get` takes no
   * `AbortSignal`, so a timed-out read is abandoned rather than cancelled.
   */
  readonly timeoutMs?: number;
  /**
   * Largest value accepted, in bytes. The value is read as a stream and the
   * load fails as soon as it passes the limit, before anything is parsed.
   * Defaults to 10 MiB, under the 25 MiB KV value limit.
   */
  readonly maxBytes?: number;
}

export const DEFAULT_FLAGS_KEY = 'flags:current';
export const DEFAULT_KV_TIMEOUT_MS = 1000;

/**
 * Loads the ruleset from Workers KV.
 *
 * The value is read with metadata so a revision can be attached to the
 * snapshot; when that revision is unchanged the provider returns `null` and the
 * client keeps its existing snapshot instead of re-parsing the payload.
 *
 * Writers should stamp `{ revision: string }` as the KV metadata. Without it
 * every load produces a fresh snapshot, which is correct, just less efficient.
 */
export class KvFlagProvider implements FlagProvider {
  readonly name = 'cloudflare-kv';

  readonly #namespace: KVNamespace;
  readonly #key: string;
  readonly #cacheTtl: number | undefined;
  readonly #onParseIssues: ((issues: readonly FlagParseIssue[]) => void) | undefined;
  readonly #lastKnownGood: LastKnownGoodStore | undefined;
  readonly #timeoutMs: number;
  readonly #maxBytes: number;

  constructor(options: KvProviderOptions) {
    this.#namespace = options.namespace;
    this.#key = options.key ?? DEFAULT_FLAGS_KEY;
    this.#cacheTtl = options.cacheTtlSeconds;
    this.#onParseIssues = options.onParseIssues;
    this.#lastKnownGood = options.lastKnownGood;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_KV_TIMEOUT_MS;
    this.#maxBytes = assertMaxBytes(options.maxBytes ?? DEFAULT_KV_MAX_BYTES);
  }

  load(previous?: FlagSnapshot, context?: ProviderLoadContext): Promise<FlagSnapshot | null> {
    const source: RulesetSourceOptions = {
      lastKnownGood: this.#lastKnownGood,
      onParseIssues: this.#onParseIssues,
      context,
    };
    return loadWithFallback(previous, () => this.#readRuleset(previous, source), source);
  }

  async #readRuleset(
    previous: FlagSnapshot | undefined,
    source: RulesetSourceOptions,
  ): Promise<FlagSnapshot | null> {
    const read = await withTimeout(
      this.#readValue(previous),
      this.#timeoutMs,
      `KV read of "${this.#key}" did not finish within ${this.#timeoutMs}ms`,
    );
    if (read === null) return null;

    const { text, revision } = read;
    const meta = revision === undefined ? {} : { version: revision };
    return snapshotFromRuleset(JSON.parse(text), meta, source);
  }

  /** The raw value and its revision, or `null` when the revision is the one already loaded. */
  async #readValue(previous: FlagSnapshot | undefined): Promise<KvValue | null> {
    const { value, metadata } = await this.#namespace.getWithMetadata<KvFlagMetadata>(this.#key, {
      type: 'stream',
      ...(this.#cacheTtl === undefined ? {} : { cacheTtl: this.#cacheTtl }),
    });

    if (value === null) {
      throw new Error(`No flag ruleset at KV key "${this.#key}"`);
    }

    const revision = metadata?.revision;
    if (revision !== undefined && previous?.version === revision) {
      await value.cancel();
      return null;
    }

    const tooLarge = (): Error =>
      new Error(`KV value "${this.#key}" is larger than maxBytes (${this.#maxBytes} bytes)`);
    return { text: await readCapped(value, this.#maxBytes, tooLarge), revision };
  }
}

interface KvValue {
  readonly text: string;
  readonly revision: string | undefined;
}

export interface KvFlagMetadata {
  readonly revision?: string;
}

async function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(message));
    }, ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
