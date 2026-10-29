/**
 * Hashed key lists: compiling them, and hashing the targeting key to probe them.
 */

import type { HashedKeyList } from '../model/flag.js';
import { isRecord } from '../parsing/primitives.js';
import { sha256Hex } from './sha256.js';

let lastKey: string | undefined;
let lastDigest = '';

/**
 * The SHA-256 digest of a targeting key, remembered for the most recent key.
 *
 * One evaluation can probe a hashed target and several hashed segments, and
 * `evaluateAll` runs every flag against one context; the one-entry memo makes
 * all of those a single hash. Evaluation is synchronous, so nothing can
 * interleave between the check and the store.
 */
export function digestOf(targetingKey: string): string {
  if (targetingKey !== lastKey) {
    lastDigest = sha256Hex(targetingKey);
    lastKey = targetingKey;
  }
  return lastDigest;
}

/**
 * The digest set of a hashed list, or `undefined` when it holds nothing usable.
 *
 * An algorithm other than `sha256` compiles to nothing: its digests can never
 * equal a SHA-256 one, so matching nobody is what the list would do anyway,
 * and saying so up front spares every evaluation the hash.
 */
export function toDigestSet(list: HashedKeyList | undefined): ReadonlySet<string> | undefined {
  if (!isRecord(list) || list.algorithm !== 'sha256' || !Array.isArray(list.values)) {
    return undefined;
  }
  const digests = new Set<string>();
  for (const value of list.values) {
    if (typeof value === 'string') digests.add(value);
  }
  return digests.size === 0 ? undefined : digests;
}
