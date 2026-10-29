import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { isStoredRuleset, type LastKnownGoodStore, type StoredRuleset } from '@kurenwimpel/core';

export interface FileLastKnownGoodStoreOptions {
  /** File the last ruleset that loaded is kept in. Its directory is created on first write. */
  readonly path: string;
}

/**
 * Keeps the last-known-good ruleset in a JSON file.
 *
 * Writes go to a temporary file that is then renamed over the target, so a
 * crash mid-write leaves the previous copy intact rather than a truncated one.
 */
export class FileLastKnownGoodStore implements LastKnownGoodStore {
  readonly #path: string;
  #lastWrite: Promise<void> = Promise.resolve();

  constructor(options: FileLastKnownGoodStoreOptions) {
    this.#path = options.path;
  }

  async read(): Promise<StoredRuleset | null> {
    let contents: string;
    try {
      contents = await readFile(this.#path, 'utf8');
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }

    const parsed: unknown = JSON.parse(contents);
    if (!isStoredRuleset(parsed)) {
      throw new Error(`Last-known-good file ${this.#path} does not hold a stored ruleset`);
    }
    return parsed;
  }

  /** Serialised, so writes land in call order and never race on the rename. */
  write(ruleset: StoredRuleset): Promise<void> {
    const write = this.#lastWrite.then(() => this.#replace(ruleset));
    this.#lastWrite = write.catch(ignoreFailure);
    return write;
  }

  async #replace(ruleset: StoredRuleset): Promise<void> {
    const temporary = `${this.#path}.${randomUUID()}.tmp`;
    await mkdir(dirname(this.#path), { recursive: true });
    try {
      await writeFile(temporary, JSON.stringify(ruleset), 'utf8');
      await rename(temporary, this.#path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/** A failed write is the caller's to report; it must not block the writes queued behind it. */
function ignoreFailure(): void {}
