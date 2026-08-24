import { readFile, stat } from 'node:fs/promises';

import {
  createSnapshot,
  parseFlagDefinitions,
  type FlagParseIssue,
  type FlagProvider,
  type FlagSnapshot,
} from '@kurenwimpel/core';

export interface FileProviderOptions {
  /** Path to a JSON file holding an array or key-to-definition object. */
  readonly path: string;
  /** Called for definitions that failed validation; the rest still load. */
  readonly onParseIssues?: (issues: readonly FlagParseIssue[]) => void;
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

  constructor(options: FileProviderOptions) {
    this.#path = options.path;
    this.#onParseIssues = options.onParseIssues;
  }

  async load(previous?: FlagSnapshot): Promise<FlagSnapshot | null> {
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

    const { flags, issues } = parseFlagDefinitions(raw);
    if (issues.length > 0) this.#onParseIssues?.(issues);

    return createSnapshot(flags, { version });
  }
}
