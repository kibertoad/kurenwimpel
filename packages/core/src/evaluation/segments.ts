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
 * One definition's compiled form, remembered against the definition itself.
 *
 * Weakly held, so a definition dropped by a refresh is not kept alive by the
 * memo — the same trade `targets.ts` makes for its folds.
 */
const compiled = new WeakMap<SegmentDefinition, Segment>();

/**
 * The compiled form of a segment, compiled at most once per definition.
 *
 * A snapshot compiles its segments up front, so the request path normally
 * meets nothing but finished ones and this is a single shape check. What it
 * guards is the other path: a segment reaching evaluation without the compiler
 * — hand-built, or an `EvaluationEnvironment` assembled straight from a JSON
 * payload — used to be compiled again on *every* membership test, allocating
 * two key sets and copying the rule list per evaluation. That is exactly the
 * per-request cost this module exists to remove, and a million-key segment
 * paid it a million insertions at a time.
 *
 * A definition mutated after its first membership test goes on being matched
 * against the form compiled then, which is the staleness a snapshot's compiled
 * segments have by construction.
 */
export function readySegment(segment: Segment | SegmentDefinition): Segment {
  if (isCompiledSegment(segment)) return segment;

  const known = compiled.get(segment);
  if (known !== undefined) return known;

  const ready = compileSegment(segment);
  compiled.set(segment, ready);
  return ready;
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
