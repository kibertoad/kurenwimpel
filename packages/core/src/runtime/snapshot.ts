/**
 * Snapshots: the immutable, point-in-time view evaluation reads from.
 *
 * Evaluation reads only from a snapshot, which is what lets the client stay
 * synchronous on the hot path while refreshes happen in the background.
 */

import { compileSegment, isCompiledSegment } from '../evaluation/segments.js';
import type { FlagDefinition } from '../model/flag.js';
import type { Segment, SegmentDefinition } from '../model/segment.js';

export interface FlagSnapshot {
  readonly flags: ReadonlyMap<string, FlagDefinition>;
  /** Segments in their compiled, set-indexed form. */
  readonly segments: ReadonlyMap<string, Segment>;
  /** Control-plane revision or ETag, when the source exposes one. */
  readonly version: string | undefined;
  /** Epoch millis the snapshot was produced. */
  readonly fetchedAt: number;
}

export interface SnapshotMeta {
  readonly version?: string;
  readonly fetchedAt?: number;
}

/**
 * Builds a snapshot. Segments may arrive in wire form or already compiled;
 * compilation happens here, once per refresh, so the request path never pays
 * for it.
 */
export function createSnapshot(
  flags: Iterable<FlagDefinition>,
  meta: SnapshotMeta = {},
  segments: Iterable<Segment | SegmentDefinition> = [],
): FlagSnapshot {
  const flagsByKey = new Map<string, FlagDefinition>();
  for (const flag of flags) flagsByKey.set(flag.key, flag);

  const segmentsByKey = new Map<string, Segment>();
  for (const segment of segments) {
    segmentsByKey.set(segment.key, isCompiledSegment(segment) ? segment : compileSegment(segment));
  }

  return {
    flags: flagsByKey,
    segments: segmentsByKey,
    version: meta.version,
    fetchedAt: meta.fetchedAt ?? Date.now(),
  };
}

export const EMPTY_SNAPSHOT: FlagSnapshot = {
  flags: new Map(),
  segments: new Map(),
  version: undefined,
  fetchedAt: 0,
};
