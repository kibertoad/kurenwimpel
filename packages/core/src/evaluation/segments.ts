/**
 * Compiling segments from their wire form to their evaluation form.
 *
 * The wire form carries key lists as JSON arrays; the compiled form holds hash
 * sets. Compilation happens once, when a snapshot is built — never on the
 * request path — so a million-key segment costs a million set insertions per
 * refresh and O(1) per evaluation.
 */

import type { Segment, SegmentDefinition } from '../model/segment.js';

const EMPTY_KEYS: ReadonlySet<string> = new Set();

/** Builds the evaluation-ready form of a segment. */
export function compileSegment(definition: SegmentDefinition): Segment {
  return {
    key: definition.key,
    included: toKeySet(definition.included),
    excluded: toKeySet(definition.excluded),
    rules: definition.rules ?? [],
  };
}

/** True when the value is already a compiled {@link Segment}. */
export function isCompiledSegment(value: Segment | SegmentDefinition): value is Segment {
  return value.included instanceof Set;
}

function toKeySet(keys: readonly string[] | undefined): ReadonlySet<string> {
  if (keys === undefined || keys.length === 0) return EMPTY_KEYS;
  return new Set(keys);
}
