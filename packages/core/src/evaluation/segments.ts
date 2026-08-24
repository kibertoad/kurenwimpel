/**
 * Compiling segments from their wire form to their evaluation form.
 *
 * The wire form carries key lists as JSON arrays; the compiled form holds hash
 * sets. Compilation happens once, when a snapshot is built — never on the
 * request path — so a million-key segment costs a million set insertions per
 * refresh and O(1) per evaluation.
 */

import type { Segment, SegmentDefinition, SegmentRule } from '../model/segment.js';

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
    rules: toRuleList(definition.rules),
  };
}

/**
 * The rule list of a segment, copied rather than aliased.
 *
 * A snapshot promises an immutable, point-in-time view — `cloneJson` and
 * `requireStringArray` keep the same promise on the parsing side — and a rule
 * list held by reference breaks it: pushing onto the caller's array afterwards
 * changes who a live snapshot matches. This is the one collection the compiler
 * used to keep from its input as-is.
 *
 * `Array.isArray` narrows an already-typed list to `any[]` and takes the
 * element type with it, so the assertion putting it back is confined here.
 */
function toRuleList(rules: readonly SegmentRule[] | undefined): readonly SegmentRule[] {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return Array.isArray(rules) ? [...(rules as readonly SegmentRule[])] : [];
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

/**
 * The set form of a key list, built fresh from whatever the definition holds.
 *
 * Anything that iterates is accepted — an array, a `Set`, a `Set` from another
 * realm, which fails `instanceof` while being exactly what it claims and used
 * to compile to nothing at all, silently losing every key. A string is not: it
 * iterates too, and reading `"u1"` as a key list would compile it to its
 * characters and grant membership to "u". Anything else fails closed.
 *
 * Always a copy, including of a `Set` that arrives ready to use, for the
 * reason the rule list is copied: the compiled segment must not alias what the
 * caller can still write to. The cost is one pass per refresh, which is the
 * trade this module already makes.
 */
function toKeySet(keys: readonly string[] | ReadonlySet<string> | undefined): ReadonlySet<string> {
  if (!isKeyIterable(keys)) return EMPTY_KEYS;
  const copy = new Set<string>(keys);
  return copy.size === 0 ? EMPTY_KEYS : copy;
}

function isKeyIterable(keys: unknown): keys is Iterable<string> {
  if (typeof keys !== 'object' || keys === null) return false;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return typeof (keys as Iterable<string>)[Symbol.iterator] === 'function';
}
