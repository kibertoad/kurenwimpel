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

/**
 * Builds the evaluation-ready form of a segment.
 *
 * Every field is taken for the shape it actually has rather than the shape its
 * type claims: a definition reaching here without the parser — hand-built, or
 * half-compiled — still comes out a complete {@link Segment}, so evaluation
 * never meets a segment with a missing set or rule list.
 */
export function compileSegment(definition: SegmentDefinition): Segment {
  return {
    key: definition.key,
    included: toKeySet(definition.included),
    excluded: toKeySet(definition.excluded),
    rules: Array.isArray(definition.rules) ? definition.rules : [],
  };
}

/**
 * True when the value is already a compiled {@link Segment}.
 *
 * All three compiled fields are checked, not just `included`. Recognising a
 * half-compiled object as finished would put it into the snapshot unvalidated,
 * and the first membership test would dereference the set it never grew.
 */
export function isCompiledSegment(value: Segment | SegmentDefinition): value is Segment {
  return (
    value.included instanceof Set && value.excluded instanceof Set && Array.isArray(value.rules)
  );
}

function toKeySet(keys: readonly string[] | ReadonlySet<string> | undefined): ReadonlySet<string> {
  if (keys instanceof Set) return keys.size === 0 ? EMPTY_KEYS : keys;
  // A key list that is not a list fails closed: a bare string would otherwise
  // compile to its characters and grant membership to "u".
  if (!Array.isArray(keys) || keys.length === 0) return EMPTY_KEYS;
  return new Set(keys);
}
