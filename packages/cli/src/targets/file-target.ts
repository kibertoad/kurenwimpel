import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { DEFAULT_KEEP } from '../config/types.js';
import type { FileTargetConfig } from '../config/types.js';
import { sha256Hex } from '../publish/revision.js';
import { revisionsToPrune } from './target.js';
import type { PublishTarget, StoredRevision } from './target.js';

const REVISION_SUFFIX = '.json';

/**
 * Writes the document to a temp file beside the target and renames it into
 * place, so a reader polling the path sees the old document or the new one,
 * never half of either. Revisions are kept in `<path>.revisions/<revision>.json`,
 * with the publish time as the file's mtime.
 */
export function fileTarget(config: FileTargetConfig): PublishTarget {
  const { path } = config;
  const directory = `${path}.revisions`;
  const keep = config.keep ?? DEFAULT_KEEP;
  const revisionPath = (revision: string): string =>
    join(directory, `${revision}${REVISION_SUFFIX}`);

  const list = async (): Promise<StoredRevision[]> => {
    const names = await whenPresent(readdir(directory));
    const revisions = (names ?? []).filter((name) => name.endsWith(REVISION_SUFFIX));
    return Promise.all(revisions.map((name) => storedRevision(directory, name)));
  };

  return {
    description: `file ${path}`,
    maxPayloadBytes: Number.POSITIVE_INFINITY,
    async currentRevision() {
      const contents = await whenPresent(readFile(path, 'utf8'));
      return contents === undefined ? undefined : sha256Hex(contents);
    },
    async write({ revision, payload, publishedAt }) {
      await mkdir(directory, { recursive: true });
      const stored = revisionPath(revision);
      await writeAtomically(stored, payload);
      const time = new Date(publishedAt);
      await utimes(stored, time, time);
      await writeAtomically(path, payload);

      const stale = revisionsToPrune(await list(), revision, keep);
      await Promise.all(stale.map((entry) => rm(revisionPath(entry.revision), { force: true })));
    },
    revisions: {
      list,
      async activate(revision) {
        const payload = await readFile(revisionPath(revision), 'utf8');
        await writeAtomically(path, payload);
      },
    },
  };
}

async function writeAtomically(path: string, contents: string): Promise<void> {
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, contents, 'utf8');
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

async function storedRevision(directory: string, name: string): Promise<StoredRevision> {
  const { mtime } = await stat(join(directory, name));
  return { revision: name.slice(0, -REVISION_SUFFIX.length), publishedAt: mtime.toISOString() };
}

/** The result, or `undefined` when the file or directory does not exist. */
async function whenPresent<T>(pending: Promise<T>): Promise<T | undefined> {
  try {
    return await pending;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
}
