/**
 * The bookkeeping a prerequisite walk carries: the memo that keeps it linear,
 * the chain that keeps it acyclic, the depth bound that keeps it off the stack,
 * and the two failures that mean the walk itself is broken.
 *
 * Split from `evaluate.ts` so the decision pipeline there reads as a pipeline.
 * Nothing here knows what a flag is — it accounts for the shape of the graph
 * and hands the verdict back.
 */

import type { EvaluationResult } from '../model/result.js';

/**
 * How deep a prerequisite chain may be before it is treated as a broken
 * definition: far past any real dependency graph, and short enough that the
 * recursion cannot exhaust the stack on the way to finding out.
 */
export const MAX_PREREQUISITE_DEPTH = 50;

/**
 * Which way a walk broke. Both are properties of the walk rather than of the
 * flag they were noticed at, and both are therefore reported against the flag
 * the caller actually asked for.
 */
export type WalkFailure = 'depth' | 'cycle';

/**
 * Raised when the walk itself is broken — a chain deeper than
 * {@link MAX_PREREQUISITE_DEPTH}, or an edge closing a cycle — and caught by
 * `evaluateFlag`, which reports it against the flag that was actually asked
 * for.
 *
 * Thrown rather than returned because neither failure belongs to the flag it
 * stops at. The very same flag is thirty prerequisites below one root and
 * fifty-one below another, and which *edge* closes a cycle depends on where the
 * walk entered it — enter the pair `a ⇄ b` at `a` and `b` names `a`, enter it
 * at `b` and `a` names `b`. A returned error would be memoised under that
 * flag's key and would then answer for it on every later lookup sharing the
 * memo: which flags a bulk response called broken would come down to the order
 * the snapshot happens to iterate in, one flag would answer differently through
 * `evaluate` than through `evaluateAll`, and two flags could be told about a
 * cycle neither of them is on. Unwinding to the root instead leaves the memo
 * holding only results that stand on their own.
 *
 * Cycles are reported at parse time too, against the whole graph at once; see
 * `parsing/references.ts`.
 */
export class PrerequisiteWalkError extends Error {
  override readonly name = 'PrerequisiteWalkError';

  readonly kind: WalkFailure;

  /**
   * For a depth failure: the prerequisite of the flag now unwinding that leads
   * into the over-deep chain, rewritten by each frame on the way up so the root
   * reports its own edge — the one thread an operator can actually pull.
   *
   * Naming the flag the guard fired at instead is not stable: a walk that
   * stopped at the limit knows the flag fifty-one levels down, and one that
   * answered the same chain from the memo knows where it truly bottoms out.
   * Both are true, which is precisely why neither belongs in a message two
   * callers must be able to compare. Unused for a cycle, whose message names
   * the edge it found.
   */
  through: string;

  private constructor(kind: WalkFailure, message: string, through: string) {
    super(message);
    this.kind = kind;
    this.through = through;
  }

  static tooDeep(through: string): PrerequisiteWalkError {
    return new PrerequisiteWalkError(
      'depth',
      `prerequisite chain more than ${MAX_PREREQUISITE_DEPTH} deep`,
      through,
    );
  }

  static cycle(from: string, to: string): PrerequisiteWalkError {
    return new PrerequisiteWalkError(
      'cycle',
      `prerequisite cycle: "${from}" requires "${to}"`,
      from,
    );
  }
}

/** The walk is broken, as opposed to a definition on it being unusable. */
export function isWalkFailure(error: unknown): error is PrerequisiteWalkError {
  return error instanceof PrerequisiteWalkError;
}

/**
 * What one flag's evaluation cost the walk: the result, and how deep the chain
 * below it ran.
 *
 * `depth` counts chain levels from this flag downward, itself included, and is
 * zero for a flag that declares no prerequisite. It is what keeps the depth
 * guard honest across a memo hit — see `evaluateDependency`.
 */
export interface PrerequisiteOutcome {
  readonly result: EvaluationResult;
  readonly depth: number;
}

/**
 * A prerequisite memo shared by several flags evaluated against one context.
 *
 * Opaque on purpose: it is a cache keyed by flag, valid only for the context it
 * was filled against. Build one with {@link createSharedMemo} and discard it
 * with the request.
 */
export type SharedPrerequisiteMemo = Map<string, PrerequisiteOutcome>;

/** The flags on the chain being walked, and the memo they all share. */
export interface PrerequisiteChain {
  /** Meeting one of these again is a cycle. */
  readonly visiting: ReadonlySet<string>;
  readonly memo: SharedPrerequisiteMemo;
  /**
   * The deepest chain size any guard at or below this frame has reached.
   * Mutable: a frame learns how far its subtree ran only once the subtree has
   * run, and `evaluateDependency` turns that into the memo entry's `depth`.
   */
  reached: number;
}

/**
 * What an evaluation carries down its prerequisite chain: a bare memo until
 * some flag on the chain declares a prerequisite, a full chain from there on.
 *
 * The two shapes share one parameter so that starting a chain costs nothing
 * until there is one to start. Most flags declare no prerequisite at all, and
 * a bulk evaluation that seeded a Set per flag up front would allocate one for
 * every flag in the ruleset only for `checkPrerequisites` to return before ever
 * reading it.
 *
 * `memo` is what keeps the walk linear. Two flags that share a dependency must
 * cost one evaluation of it, not one per path that reaches it — otherwise a
 * chain of depth n costs 2^n, and a control plane can turn a single lookup into
 * seconds of CPU. Every entry was computed against the same context, which is
 * fixed for the whole walk.
 */
export type PrerequisiteTrail = SharedPrerequisiteMemo | PrerequisiteChain;

/**
 * A memo to hand to every `evaluateFlag` call of one bulk evaluation.
 *
 * Each flag otherwise seeds a memo of its own, which keeps a single flag's
 * chain linear but does nothing across flags: a kill switch that gates 200 of
 * them is evaluated 200 times, and everything beneath it with it. Sharing the
 * memo makes a bulk response O(flags + edges) instead of O(flags × depth).
 *
 * Only the memo is shared. Every flag still gets its own `visiting` chain, or
 * one flag's ancestry would read as another flag's cycle.
 */
export function createSharedMemo(): SharedPrerequisiteMemo {
  return new Map();
}

/**
 * The chain to walk from here: the one already in progress, or a fresh one
 * rooted at this flag.
 *
 * Built lazily rather than by the entry point, so a flag that declares no
 * prerequisite — the overwhelming majority of any ruleset — costs no allocation
 * at all, memo or no memo. The root's own key has to go on the chain, or a
 * hand-built flag naming itself would recurse instead of being reported as a
 * cycle.
 *
 * The two shapes are told apart by what a chain carries rather than by
 * `instanceof Map`, which `segments.ts` refuses for the same reason: a memo
 * built in another realm — a `vm` context, a worker, a second copy of the
 * package in one bundle — is exactly what it claims to be and still fails the
 * test. Read as a chain, it would dereference a `visiting` set it does not
 * have, and the TypeError would unwind into `evaluateFlag`'s catch and report a
 * perfectly good flag as an unusable definition.
 */
export function chainFrom(key: string, trail: PrerequisiteTrail | undefined): PrerequisiteChain {
  if (isChain(trail)) return trail;
  return { visiting: new Set([key]), memo: isMemo(trail) ? trail : new Map(), reached: 0 };
}

/** A trail that has already started a chain is the one carrying its flags. */
function isChain(trail: unknown): trail is PrerequisiteChain {
  return typeof trail === 'object' && trail !== null && 'visiting' in trail;
}

/**
 * Whether the memo handed over can be used as one.
 *
 * {@link createSharedMemo} is the documented way to make one, but the parameter
 * is public and a JavaScript caller can pass anything at all. A fresh memo costs
 * one allocation on a path that was going to allocate a `Set` regardless, and
 * keeps the walk from throwing over the caller's mistake.
 */
function isMemo(trail: unknown): trail is SharedPrerequisiteMemo {
  if (typeof trail !== 'object' || trail === null) return false;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const candidate = trail as SharedPrerequisiteMemo;
  return typeof candidate.get === 'function' && typeof candidate.set === 'function';
}

/**
 * Records how far a subtree ran, and throws if that is further than the walk
 * allows — the same verdict the guard in `checkPrerequisites` reaches on the way
 * down, reached here on the way back up, including from a memo hit.
 */
export function reach(chain: PrerequisiteChain, size: number, through: string): void {
  if (size > MAX_PREREQUISITE_DEPTH) throw PrerequisiteWalkError.tooDeep(through);
  if (size > chain.reached) chain.reached = size;
}
