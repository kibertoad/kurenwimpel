/**
 * The seam between the agnostic core and a platform.
 *
 * Service wrappers implement {@link FlagProvider} over whatever storage they
 * have — Workers KV, a file on disk, an HTTP control plane — and the core
 * stays unaware of it.
 */

import type { FlagDefinition } from '../model/flag.js';
import type { Segment, SegmentDefinition } from '../model/segment.js';
import type { FlagParseIssue } from '../parsing/primitives.js';
import { createSnapshot } from './snapshot.js';
import type { FlagSnapshot, SnapshotMeta } from './snapshot.js';

/** What the client hands a provider on each load. */
export interface ProviderLoadContext {
  /** Reports a failure that did not stop the load, such as an outage covered by a fallback. */
  readonly reportError: (error: unknown, operation: 'load' | 'store') => void;
  /**
   * Reports the issues from parsing a ruleset, an empty list for a clean parse.
   * Feeds `status().lastParseIssueCount`.
   */
  readonly reportParseIssues?: (issues: readonly FlagParseIssue[]) => void;
}

export interface FlagProvider {
  readonly name: string;

  /**
   * Fetches the current flags.
   *
   * `previous` is passed so a provider can do a conditional fetch; return
   * `null` to signal "nothing changed" and keep the existing snapshot.
   */
  load(previous?: FlagSnapshot, context?: ProviderLoadContext): Promise<FlagSnapshot | null>;

  /** Releases timers, sockets, or watchers. Called by `FeatureFlagClient.close()`. */
  close?(): Promise<void>;
}

export interface StaticProviderContents extends SnapshotMeta {
  readonly segments?: Iterable<Segment | SegmentDefinition>;
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

  constructor(flags: Iterable<FlagDefinition> = [], contents: StaticProviderContents = {}) {
    this.#snapshot = createSnapshot(flags, contents, contents.segments ?? []);
  }

  load(): Promise<FlagSnapshot | null> {
    return Promise.resolve(this.#snapshot);
  }

  /** Replaces the held definitions. The next `load()` returns them. */
  replace(flags: Iterable<FlagDefinition>, contents: StaticProviderContents = {}): void {
    this.#snapshot = createSnapshot(flags, contents, contents.segments ?? []);
  }
}
