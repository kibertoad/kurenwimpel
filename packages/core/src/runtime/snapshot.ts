/**
 * Snapshots: the immutable, point-in-time view evaluation reads from.
 *
 * Evaluation reads only from a snapshot, which is what lets the client stay
 * synchronous on the hot path while refreshes happen in the background.
 */

import type { EvaluationEnvironment } from '../evaluation/evaluate.js';
import { compileSegment, isCompiledSegment } from '../evaluation/segments.js';
import { buildTargetIndex } from '../evaluation/targets.js';
import type { TargetIndex } from '../evaluation/targets.js';
import type { FlagDefinition } from '../model/flag.js';
import type { Segment, SegmentDefinition } from '../model/segment.js';

export interface FlagSnapshot {
  readonly flags: ReadonlyMap<string, FlagDefinition>;
  /** Segments in their compiled, set-indexed form. */
  readonly segments: ReadonlyMap<string, Segment>;
  /** Individual targets, folded into one key-to-variant lookup per flag. */
  readonly targetIndex: TargetIndex;
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
 * Builds a snapshot. Segments may arrive in wire form or already compiled, and
 * individual targets are indexed here; all of that compilation happens once per
 * refresh, so the request path never pays for it.
 */
export function createSnapshot(
  flags: Iterable<FlagDefinition>,
  meta: SnapshotMeta = {},
  segments: Iterable<Segment | SegmentDefinition> = [],
): FlagSnapshot {
  // First wins, on both sides, which is the rule `parseEach` already follows:
  // which of two definitions of one key ends up live must not come down to
  // input order. The two halves of the pipeline used to disagree — the parser
  // kept the first and reported the rest, this kept the last — so a provider
  // assembling flags from more than one source, a compiled-in bootstrap merged
  // with a fetched ruleset, got the opposite answer from each.
  const flagsByKey = new Map<string, FlagDefinition>();
  for (const flag of flags) {
    if (!flagsByKey.has(flag.key)) flagsByKey.set(flag.key, flag);
  }

  const segmentsByKey = new Map<string, Segment>();
  for (const segment of segments) {
    if (segmentsByKey.has(segment.key)) continue;
    segmentsByKey.set(segment.key, isCompiledSegment(segment) ? segment : compileSegment(segment));
  }

  return {
    flags: flagsByKey,
    segments: segmentsByKey,
    targetIndex: buildTargetIndex(flagsByKey.values()),
    version: meta.version,
    fetchedAt: meta.fetchedAt ?? Date.now(),
  };
}

/**
 * The lookups evaluation needs from a snapshot, in the shape it wants them.
 *
 * Derived once per snapshot rather than per evaluation: the hot path should not
 * allocate an environment object per lookup. It sits beside
 * {@link completeSnapshot}, which is what makes every field of it present.
 */
export function environmentOf(snapshot: FlagSnapshot): EvaluationEnvironment {
  return {
    flags: snapshot.flags,
    segments: snapshot.segments,
    targetIndex: snapshot.targetIndex,
  };
}

/**
 * A snapshot carrying every lookup evaluation reads, from one that may be
 * missing some.
 *
 * `segments` and `targetIndex` are required fields of {@link FlagSnapshot},
 * but the only thing enforcing that is a type. A snapshot reaches the client
 * from `setSnapshot`, which is public, and from any third-party
 * {@link FlagProvider} — a JavaScript consumer, an untyped test fixture, or a
 * provider written against the shape before those two fields existed builds
 * `{ flags, version, fetchedAt }` literally and is accepted. It then installs
 * a client whose every `inSegment` rule matches nobody and whose every
 * `notInSegment` matches nobody either — both fail closed, correctly, on a
 * segment map that is not there — with no error, no warning and no reason code
 * to say why, and whose `snapshot.segments` reads back `undefined` to anyone
 * inspecting it.
 *
 * The index is rebuilt rather than defaulted, because it can be: it is derived
 * from the flags, which are present. The segments cannot be — a snapshot that
 * never carried them has none — so they default to empty, which is the same
 * answer, arrived at explicitly.
 *
 * A snapshot straight from {@link createSnapshot} is handed back untouched.
 */
export function completeSnapshot(snapshot: FlagSnapshot): FlagSnapshot {
  const hasSegments = isLookup(snapshot.segments);
  const hasTargetIndex = isLookup(snapshot.targetIndex);
  if (hasSegments && hasTargetIndex) return snapshot;

  return {
    ...snapshot,
    segments: hasSegments ? snapshot.segments : new Map<string, Segment>(),
    targetIndex: hasTargetIndex ? snapshot.targetIndex : buildTargetIndex(snapshot.flags.values()),
  };
}

/**
 * Whether a field is something evaluation can look a key up in.
 *
 * Duck-typed rather than `instanceof Map`, for the reason `segments.ts` gives:
 * a Map built in another realm is exactly what it claims to be and still fails
 * the test, and rebuilding a perfectly good index over it would be the wrong
 * answer to the right question.
 */
function isLookup(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return typeof (value as ReadonlyMap<unknown, unknown>).get === 'function';
}

export const EMPTY_SNAPSHOT: FlagSnapshot = {
  flags: new Map(),
  segments: new Map(),
  targetIndex: new Map(),
  version: undefined,
  fetchedAt: 0,
};
