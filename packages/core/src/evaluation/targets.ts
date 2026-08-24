/**
 * Compiling individual targets from their wire form to their evaluation form.
 *
 * The wire form carries each target's keys as a JSON array, so a lookup would
 * be a scan over every target of the flag times every key in it. Snapshots fold
 * them into one map per flag instead — built once per refresh, never on the
 * request path — the same trade segments make.
 */

import type { FlagDefinition } from '../model/flag.js';

/** Per flag key, the variant each individually targeted key is pinned to. */
export type TargetIndex = ReadonlyMap<string, ReadonlyMap<string, string>>;

/**
 * Folds one flag's targets into a single lookup.
 *
 * Returns `undefined` when the flag targets nobody, so the index carries no
 * empty maps. The first target claiming a key wins, which is what the scan it
 * replaces did; the parser rejects a key claimed twice, so only a hand-built
 * flag can reach that case.
 */
export function compileTargets(flag: FlagDefinition): ReadonlyMap<string, string> | undefined {
  if (flag.targets === undefined || flag.targets.length === 0) return undefined;

  const byKey = new Map<string, string>();
  for (const target of flag.targets) {
    if (!isKeyList(target.keys)) continue;

    for (const key of target.keys) {
      if (!byKey.has(key)) byKey.set(key, target.variant);
    }
  }

  return byKey.size === 0 ? undefined : byKey;
}

/**
 * Whether a target's `keys` really is a list. Hand-built flags reach this too,
 * and one that is not a list targets nobody rather than being iterated for
 * whatever it happens to yield.
 */
function isKeyList(keys: readonly string[]): boolean {
  return Array.isArray(keys);
}

/**
 * One flag's fold, remembered against the definition itself.
 *
 * Weakly held, so a definition dropped by a refresh is not kept alive by the
 * memo. `null` records "folded, and it targets nobody", which is what
 * separates a cached negative from an entry that was never made.
 */
const folded = new WeakMap<FlagDefinition, ReadonlyMap<string, string> | null>();

/**
 * {@link compileTargets}, paid once per definition.
 *
 * A snapshot's index is the normal path, but two cases reach evaluation with
 * no entry in one: a flag evaluated directly through `evaluateFlag`, outside
 * any snapshot, and a flag whose targets fold to nothing, which
 * {@link buildTargetIndex} deliberately leaves out. Folding on the spot each
 * time puts back the exact O(n)-per-request cost the index exists to remove —
 * a flag with a hundred thousand targeted keys rebuilt a hundred-thousand-entry
 * map per evaluation, and one targeting nobody allocated a throwaway map per
 * evaluation forever.
 *
 * A definition mutated after its first evaluation goes on serving the fold
 * taken then, which is the staleness a snapshot's index has by construction.
 */
export function foldedTargets(flag: FlagDefinition): ReadonlyMap<string, string> | undefined {
  const known = folded.get(flag);
  if (known !== undefined) return known ?? undefined;

  const compiled = compileTargets(flag) ?? null;
  folded.set(flag, compiled);
  return compiled ?? undefined;
}

/** Builds the whole snapshot's index. Flags that target nobody are left out. */
export function buildTargetIndex(flags: Iterable<FlagDefinition>): TargetIndex {
  const index = new Map<string, ReadonlyMap<string, string>>();

  for (const flag of flags) {
    const compiled = compileTargets(flag);
    if (compiled !== undefined) index.set(flag.key, compiled);
  }

  return index;
}
