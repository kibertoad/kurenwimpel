import { byNewest } from '../targets/target.js';
import type { PublishTarget, RevisionStore, StoredRevision } from '../targets/target.js';

export interface RevisionEntry extends StoredRevision {
  /** Whether the target serves this revision now. */
  readonly current: boolean;
}

export interface RollbackResult {
  /** `unchanged` when the target already served the requested revision. */
  readonly status: 'rolled-back' | 'unchanged';
  readonly from: string | undefined;
  readonly to: string;
}

/** A rollback or listing that cannot proceed. Nothing was written. */
export class RevisionError extends Error {
  override readonly name = 'RevisionError';
}

/** The stored revisions, newest first. */
export async function listRevisions(target: PublishTarget): Promise<RevisionEntry[]> {
  const store = storeOf(target);
  const [stored, current] = await Promise.all([store.list(), target.currentRevision()]);
  return stored.toSorted(byNewest).map(({ revision, publishedAt }) => ({
    revision,
    publishedAt,
    current: revision === current,
  }));
}

/**
 * Points the target back at a stored revision without rebuilding anything.
 *
 * `to` is a revision or a unique prefix of one. Without it, the target goes
 * back to the newest revision published before the current one, so repeated
 * rollbacks walk back through history.
 */
export async function rollbackRuleset(
  target: PublishTarget,
  options: { readonly to?: string } = {},
): Promise<RollbackResult> {
  const store = storeOf(target);
  const entries = await listRevisions(target);
  const from = await target.currentRevision();
  const to = options.to === undefined ? previousOf(entries) : matching(entries, options.to);

  if (to === from) return { status: 'unchanged', from, to };
  await store.activate(to);
  return { status: 'rolled-back', from, to };
}

function storeOf(target: PublishTarget): RevisionStore {
  if (target.revisions === undefined) {
    throw new RevisionError(`${target.description} keeps no revisions to roll back to`);
  }
  return target.revisions;
}

function previousOf(newestFirst: readonly RevisionEntry[]): string {
  const current = newestFirst.findIndex((entry) => entry.current);
  const previous = newestFirst[current + 1];
  if (previous === undefined) throw new RevisionError('no earlier revision is stored');
  return previous.revision;
}

function matching(entries: readonly RevisionEntry[], wanted: string): string {
  const exact = entries.find((entry) => entry.revision === wanted);
  if (exact !== undefined) return exact.revision;

  const candidates = entries.filter((entry) => entry.revision.startsWith(wanted));
  if (candidates.length === 1) return candidates[0]!.revision;
  if (candidates.length === 0) throw new RevisionError(`revision ${wanted} is not stored`);
  throw new RevisionError(`revision prefix ${wanted} matches ${candidates.length} revisions`);
}
