/** One document about to be written. */
export interface PublishedRevision {
  readonly revision: string;
  /** The canonical JSON of the ruleset. */
  readonly payload: string;
  /** ISO 8601. */
  readonly publishedAt: string;
}

export interface StoredRevision {
  readonly revision: string;
  /** ISO 8601, or `undefined` when the store did not record it. */
  readonly publishedAt: string | undefined;
}

/**
 * Somewhere a ruleset is published to. Implementations own their write order:
 * a target that keeps revisions stores the new one before repointing the
 * current document at it.
 */
export interface PublishTarget {
  /** Human readable, for output: "kv namespace 0f2a key flags:current". */
  readonly description: string;
  /** The largest payload this target accepts, in bytes. */
  readonly maxPayloadBytes: number;
  /** The revision live now, or `undefined` when nothing was published yet. */
  currentRevision(): Promise<string | undefined>;
  write(published: PublishedRevision): Promise<void>;
  /** Present on targets that keep earlier revisions for rollback. */
  readonly revisions?: RevisionStore;
}

export interface RevisionStore {
  /** Every stored revision, in no particular order. */
  list(): Promise<StoredRevision[]>;
  /** Makes a stored revision the current document again, without rewriting its history. */
  activate(revision: string): Promise<void>;
}

/** What a target may reach outside itself. Credentials come from `env` only. */
export interface TargetDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch: typeof fetch;
  /** Request signing time. Defaults to the system clock. */
  readonly now?: () => Date;
}

/** A credential variable that is unset. Exits with code 2. */
export function requireEnv(deps: TargetDeps, name: string, purpose: string): string {
  const value = deps.env[name];
  if (value === undefined || value === '') {
    throw new MissingCredentialError(`${purpose}: environment variable ${name} is not set`);
  }
  return value;
}

export class MissingCredentialError extends Error {
  override readonly name = 'MissingCredentialError';
}

export const MIB = 1024 * 1024;

/** Keeps the `keep` newest revisions, plus the live one wherever it sorts. */
export function revisionsToPrune(
  stored: readonly StoredRevision[],
  current: string,
  keep: number,
): StoredRevision[] {
  const newestFirst = stored.toSorted(byNewest);
  return newestFirst.slice(keep).filter((entry) => entry.revision !== current);
}

/** Newest first; a revision with no timestamp sorts last. ISO 8601 UTC strings order by code unit. */
export function byNewest(a: StoredRevision, b: StoredRevision): number {
  const left = a.publishedAt ?? '';
  const right = b.publishedAt ?? '';
  if (left === right) return 0;
  return left < right ? 1 : -1;
}
