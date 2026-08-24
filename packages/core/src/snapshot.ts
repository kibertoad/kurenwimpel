import type { FlagDefinition } from './types.js';

/**
 * An immutable, point-in-time view of every flag.
 *
 * Evaluation reads only from a snapshot, which is what lets the client stay
 * synchronous on the hot path while refreshes happen in the background.
 */
export interface FlagSnapshot {
  readonly flags: ReadonlyMap<string, FlagDefinition>;
  /** Control-plane revision or ETag, when the source exposes one. */
  readonly version: string | undefined;
  /** Epoch millis the snapshot was produced. */
  readonly fetchedAt: number;
}

export interface SnapshotMeta {
  readonly version?: string;
  readonly fetchedAt?: number;
}

export function createSnapshot(
  flags: Iterable<FlagDefinition>,
  meta: SnapshotMeta = {},
): FlagSnapshot {
  const byKey = new Map<string, FlagDefinition>();
  for (const flag of flags) byKey.set(flag.key, flag);

  return {
    flags: byKey,
    version: meta.version,
    fetchedAt: meta.fetchedAt ?? Date.now(),
  };
}

export const EMPTY_SNAPSHOT: FlagSnapshot = {
  flags: new Map(),
  version: undefined,
  fetchedAt: 0,
};

/**
 * The seam between the agnostic core and a platform.
 *
 * Service wrappers implement this over whatever storage they have — Workers KV,
 * a file on disk, an HTTP control plane — and the core stays unaware of it.
 */
export interface FlagProvider {
  readonly name: string;

  /**
   * Fetches the current flags.
   *
   * `previous` is passed so a provider can do a conditional fetch; return
   * `null` to signal "nothing changed" and keep the existing snapshot.
   */
  load(previous?: FlagSnapshot): Promise<FlagSnapshot | null>;

  /** Releases timers, sockets, or watchers. Called by `FeatureFlagClient.close()`. */
  close?(): Promise<void>;
}

/**
 * A provider backed by definitions held in memory.
 *
 * Useful as a test double, as a bootstrap fallback when a remote source is
 * unreachable, and for services that compile their flags in.
 */
export class StaticProvider implements FlagProvider {
  readonly name = 'static';

  #snapshot: FlagSnapshot;

  constructor(flags: Iterable<FlagDefinition> = [], meta?: SnapshotMeta) {
    this.#snapshot = createSnapshot(flags, meta);
  }

  load(): Promise<FlagSnapshot | null> {
    return Promise.resolve(this.#snapshot);
  }

  /** Replaces the held definitions. The next `load()` returns them. */
  replace(flags: Iterable<FlagDefinition>, meta?: SnapshotMeta): void {
    this.#snapshot = createSnapshot(flags, meta);
  }
}
