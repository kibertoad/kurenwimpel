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
}

export const DEFAULT_FLAGS_KEY = 'flags:current';

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

  constructor(options: KvProviderOptions) {
    this.#namespace = options.namespace;
    this.#key = options.key ?? DEFAULT_FLAGS_KEY;
    this.#cacheTtl = options.cacheTtlSeconds;
    this.#onParseIssues = options.onParseIssues;
    this.#lastKnownGood = options.lastKnownGood;
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
    const { value, metadata } = await this.#namespace.getWithMetadata<unknown, KvFlagMetadata>(
      this.#key,
      {
        type: 'json',
        ...(this.#cacheTtl === undefined ? {} : { cacheTtl: this.#cacheTtl }),
      },
    );

    if (value === null) {
      throw new Error(`No flag ruleset at KV key "${this.#key}"`);
    }

    const revision = metadata?.revision;
    if (revision !== undefined && previous?.version === revision) return null;

    return snapshotFromRuleset(value, revision === undefined ? {} : { version: revision }, source);
  }
}

export interface KvFlagMetadata {
  readonly revision?: string;
}
