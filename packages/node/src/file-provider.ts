import { readFile, stat } from 'node:fs/promises';

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

export interface FileProviderOptions {
  /** Path to a JSON file holding flag definitions, or a `{ flags, segments }` document. */
  readonly path: string;
  /** Called for definitions that failed validation; the rest still load. */
  readonly onParseIssues?: (issues: readonly FlagParseIssue[]) => void;
  /** Where to keep the last ruleset that loaded, to boot from when the file is unreadable. */
  readonly lastKnownGood?: LastKnownGoodStore;
}

/**
 * Reads the ruleset from a JSON file on disk.
 *
 * Intended for flags shipped with the deployment, mounted from a ConfigMap, or
 * written by a sidecar. Reloads are skipped when the file's mtime and size are
 * both unchanged, so polling this cheaply is fine.
 */
export class FileFlagProvider implements FlagProvider {
  readonly name = 'file';

  readonly #path: string;
  readonly #onParseIssues: ((issues: readonly FlagParseIssue[]) => void) | undefined;
  readonly #lastKnownGood: LastKnownGoodStore | undefined;

  constructor(options: FileProviderOptions) {
    this.#path = options.path;
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
    const stats = await stat(this.#path);
    const version = `${stats.mtimeMs}:${stats.size}`;

    if (previous?.version === version) return null;

    const contents = await readFile(this.#path, 'utf8');

    let raw: unknown;
    try {
      raw = JSON.parse(contents);
    } catch (error) {
      throw new Error(`Flag file ${this.#path} is not valid JSON`, { cause: error });
    }

    return snapshotFromRuleset(raw, { version }, source);
  }
}
