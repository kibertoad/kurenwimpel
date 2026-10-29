/**
 * Validation for a flag's individual targets.
 */

import type { HashedKeyList, VariantTarget } from '../model/flag.js';
import { parseHashedKeyList } from './hashed-keys.js';
import { fail, isRecord, requireString, requireStringArray } from './primitives.js';

/** Keys and digests already claimed by an earlier target of the same flag. */
interface Claimed {
  readonly keys: Set<string>;
  readonly digests: Set<string>;
}

export function parseTargets(
  raw: unknown,
  key: string,
  variantNames: ReadonlySet<string>,
): VariantTarget[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) fail(`flag ${key}: targets must be an array`);

  const claimed: Claimed = { keys: new Set(), digests: new Set() };

  return raw.map((entry: unknown, index: number): VariantTarget => {
    if (!isRecord(entry)) fail(`flag ${key}: target ${index} must be an object`);

    const variant = requireString(entry['variant'], `flag ${key}: target ${index} variant`);
    if (!variantNames.has(variant)) {
      fail(`flag ${key}: target points at unknown variant ${variant}`);
    }

    const where = `flag ${key}: target ${variant}`;
    const keyHashes = parseHashedKeyList(entry['keyHashes'], `${where} keyHashes`);

    // `keys` stays mandatory for a target without hashes, so a target naming
    // nobody is still reported against the field an operator most likely meant.
    const rawKeys = entry['keys'] ?? undefined;
    const keys =
      rawKeys === undefined && keyHashes !== undefined
        ? undefined
        : requireStringArray(rawKeys, `${where} keys`);

    if (keys !== undefined) claim(keys, claimed.keys, { key, where, noun: 'targeting key' });
    if (keyHashes !== undefined) {
      claim(keyHashes.values, claimed.digests, { key, where, noun: 'key hash' });
    }

    return withLists(variant, keys, keyHashes);
  });
}

function withLists(
  variant: string,
  keys: string[] | undefined,
  keyHashes: HashedKeyList | undefined,
): VariantTarget {
  return {
    variant,
    ...(keys === undefined ? {} : { keys }),
    ...(keyHashes === undefined ? {} : { keyHashes }),
  };
}

interface ClaimSite {
  readonly key: string;
  readonly where: string;
  readonly noun: string;
}

/**
 * Two defects, told apart, because they send an operator to different places.
 * `seen` spans the whole flag and catches an entry two targets both claim;
 * `own` is this target's list, and a repeat inside it reported as appearing
 * "in more than one target" would send whoever read it looking for a second
 * target that does not exist.
 */
function claim(list: readonly string[], seen: Set<string>, site: ClaimSite): void {
  const { key, where, noun } = site;
  const own = new Set<string>();
  for (const entry of list) {
    if (own.has(entry)) fail(`${where} lists ${noun} "${entry}" more than once`);
    if (seen.has(entry)) fail(`flag ${key}: ${noun} "${entry}" appears in more than one target`);
    own.add(entry);
    seen.add(entry);
  }
}
