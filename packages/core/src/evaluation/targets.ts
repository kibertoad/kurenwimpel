/**
 * Compiling individual targets from their wire form to their evaluation form.
 *
 * The wire form carries each target's keys as a JSON array, so a lookup would
 * be a scan over every target of the flag times every key in it. Snapshots fold
 * them into one map per flag instead, built once per refresh and never on the
 * request path: the same trade segments make.
 */

import type { FlagDefinition, VariantTarget } from '../model/flag.js';
import { isRecord } from '../parsing/primitives.js';
import { digestOf, toDigestSet } from './hashed-keys.js';

/** Per flag key, the variant each individually targeted key is pinned to. */
export type TargetIndex = ReadonlyMap<string, ReadonlyMap<string, string>>;

/**
 * Folds one flag's plain target keys into a single lookup.
 *
 * Returns `undefined` when the flag targets nobody, so the index carries no
 * empty maps. The first target claiming a key wins, which is what the scan it
 * replaces did; the parser rejects a key claimed twice, so only a hand-built
 * flag can reach that case.
 */
export function compileTargets(flag: FlagDefinition): ReadonlyMap<string, string> | undefined {
  return foldTargets(flag, plainKeysOf);
}

/**
 * {@link compileTargets} for each target's `keyHashes`: digest to variant. A
 * plain match is probed first, so a key listed in both forms serves the plain
 * target's variant.
 */
export function compileHashedTargets(
  flag: FlagDefinition,
): ReadonlyMap<string, string> | undefined {
  return foldTargets(flag, (target) => toDigestSet(target.keyHashes));
}

function foldTargets(
  flag: FlagDefinition,
  keysOf: (target: VariantTarget) => Iterable<string> | undefined,
): ReadonlyMap<string, string> | undefined {
  const targets = flag.targets;
  if (!isTargetList(targets) || targets.length === 0) return undefined;

  const byKey = new Map<string, string>();
  for (const target of targets) {
    const keys = isRecord(target) ? keysOf(target) : undefined;
    if (keys === undefined) continue;

    for (const key of keys) {
      if (!byKey.has(key)) byKey.set(key, target.variant);
    }
  }

  return byKey.size === 0 ? undefined : byKey;
}

/**
 * Whether a flag's `targets` really is a list.
 *
 * A predicate rather than a bare `Array.isArray`, which narrows an
 * already-typed list to `any[]` and takes the element type with it: the same
 * reason `segments.ts` confines its own assertion to one helper.
 */
function isTargetList(
  targets: readonly VariantTarget[] | undefined,
): targets is readonly VariantTarget[] {
  return Array.isArray(targets);
}

/**
 * The plain keys of one target, when it carries a list of them.
 *
 * `buildTargetIndex` runs over every flag of every snapshot, so a hand-built
 * target that is `null`, a number, or holds no key list must not throw out of
 * `createSnapshot` and cost the whole refresh its ruleset, where the very same
 * definition handed to `evaluateFlag` degrades to one flag reporting
 * INVALID_DEFINITION. A target that cannot be read targets nobody.
 */
function plainKeysOf(target: VariantTarget): readonly string[] | undefined {
  return isStringList(target.keys) ? target.keys : undefined;
}

function isStringList(keys: readonly string[] | undefined): keys is readonly string[] {
  return Array.isArray(keys);
}

type Fold = ReadonlyMap<string, string> | null;

/**
 * One flag's folds, remembered against the definition itself.
 *
 * Weakly held, so a definition dropped by a refresh is not kept alive by the
 * memo. `null` records "folded, and it targets nobody", which is what
 * separates a cached negative from an entry that was never made.
 */
const folded = new WeakMap<FlagDefinition, Fold>();
const foldedHashes = new WeakMap<FlagDefinition, Fold>();

/**
 * {@link compileTargets}, paid once per definition.
 *
 * A snapshot's index is the normal path, but two cases reach evaluation with
 * no entry in one: a flag evaluated directly through `evaluateFlag`, outside
 * any snapshot, and a flag whose targets fold to nothing, which
 * {@link buildTargetIndex} deliberately leaves out. Folding on the spot each
 * time would put the O(n)-per-request cost the index exists to remove back on
 * every evaluation.
 *
 * A definition mutated after its first evaluation goes on serving the fold
 * taken then, which is the staleness a snapshot's index has by construction.
 */
export function foldedTargets(flag: FlagDefinition): ReadonlyMap<string, string> | undefined {
  return remembered(folded, flag, compileTargets);
}

/** {@link compileHashedTargets}, paid once per definition like {@link foldedTargets}. */
export function foldedHashedTargets(flag: FlagDefinition): ReadonlyMap<string, string> | undefined {
  return remembered(foldedHashes, flag, compileHashedTargets);
}

/**
 * The variant a hashed target pins this key to, if any. The key is hashed only
 * when the flag has hashed targets at all.
 */
export function hashedTargetOf(flag: FlagDefinition, targetingKey: string): string | undefined {
  const byDigest = foldedHashedTargets(flag);
  return byDigest === undefined ? undefined : byDigest.get(digestOf(targetingKey));
}

function remembered(
  memo: WeakMap<FlagDefinition, Fold>,
  flag: FlagDefinition,
  compile: (flag: FlagDefinition) => ReadonlyMap<string, string> | undefined,
): ReadonlyMap<string, string> | undefined {
  const known = memo.get(flag);
  if (known !== undefined) return known ?? undefined;

  const compiled = compile(flag) ?? null;
  memo.set(flag, compiled);
  return compiled ?? undefined;
}

/**
 * Builds the whole snapshot's index. Flags that target nobody are left out.
 *
 * Digest folds stay in their memo rather than the index, which keeps the
 * index's public shape; building them here puts that cost on the refresh
 * instead of the first request.
 */
export function buildTargetIndex(flags: Iterable<FlagDefinition>): TargetIndex {
  const index = new Map<string, ReadonlyMap<string, string>>();

  for (const flag of flags) {
    const compiled = compileTargets(flag);
    if (compiled !== undefined) index.set(flag.key, compiled);
    foldedHashedTargets(flag);
  }

  return index;
}
