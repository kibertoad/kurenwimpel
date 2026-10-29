/**
 * Segments: named, reusable audiences.
 *
 * A segment is defined once and referenced from any number of flags through
 * the `inSegment` / `notInSegment` condition operators, so "beta testers" or
 * "EU enterprise accounts" is maintained in one place rather than copied into
 * every flag that targets it.
 */

import type { Condition, HashedKeyList } from './flag.js';

/**
 * A rule granting segment membership. All conditions must match; a segment
 * with several rules is the OR of them. Segment rules may not use the segment
 * operators themselves — membership never recurses, so it can never cycle.
 */
export interface SegmentRule {
  readonly id: string;
  readonly conditions: readonly Condition[];
}

/**
 * A segment as stored in the control plane.
 *
 * Membership is decided in strict order: a targeting key in `excluded` or
 * `excludedHashes` is out, one in `included` or `includedHashes` is in, and
 * otherwise the rules decide. The lists hold targeting keys, or their SHA-256
 * digests, and may be large; they are compiled to hash sets before evaluation
 * ever sees them.
 */
export interface SegmentDefinition {
  readonly key: string;
  readonly included?: readonly string[];
  readonly excluded?: readonly string[];
  readonly includedHashes?: HashedKeyList;
  readonly excludedHashes?: HashedKeyList;
  readonly rules?: readonly SegmentRule[];
}

/**
 * The evaluation-ready form of a segment: key lists as sets, so membership is
 * O(1) however many keys the control plane shipped. Built once per snapshot by
 * `compileSegment`, never on the request path.
 *
 * The digest sets are present only when the definition declared hashes, which
 * is what lets a segment without them skip hashing the targeting key.
 */
export interface Segment {
  readonly key: string;
  readonly included: ReadonlySet<string>;
  readonly excluded: ReadonlySet<string>;
  readonly includedHashes?: ReadonlySet<string>;
  readonly excludedHashes?: ReadonlySet<string>;
  readonly rules: readonly SegmentRule[];
}
