/**
 * Deterministic bucketing.
 *
 * Rollouts must land the same subject in the same bucket on every runtime and
 * in every process, so this is a hand-rolled MurmurHash3 (x86, 32-bit) rather
 * than anything from `node:crypto` or WebCrypto — both of which are either
 * unavailable or async somewhere we want to run.
 */

// Declared locally rather than pulled in from lib.dom or @types/node: core must
// not commit consumers to a platform's global type surface. TextEncoder is
// WHATWG Encoding, present in Node, browsers, Workers, Deno, and Bun alike.
declare const TextEncoder: new () => { encode(input: string): Uint8Array };

const encoder = new TextEncoder();

const C1 = 0xcc9e_2d51;
const C2 = 0x1b87_3593;

/** MurmurHash3 x86 32-bit over the UTF-8 bytes of `input`. */
export function murmurHash3(input: string, seed = 0): number {
  const data = encoder.encode(input);
  const length = data.length;
  const blockCount = length >> 2;

  let h1 = seed >>> 0;

  for (let index = 0; index < blockCount; index++) {
    const offset = index << 2;
    let k1 =
      (data[offset]! |
        (data[offset + 1]! << 8) |
        (data[offset + 2]! << 16) |
        (data[offset + 3]! << 24)) >>>
      0;

    k1 = Math.imul(k1, C1);
    k1 = (k1 << 15) | (k1 >>> 17);
    k1 = Math.imul(k1, C2);

    h1 ^= k1;
    h1 = (h1 << 13) | (h1 >>> 19);
    h1 = (Math.imul(h1, 5) + 0xe654_6b64) >>> 0;
  }

  // Tail: the 0-3 bytes that did not fill a block.
  const tail = blockCount << 2;
  const remainder = length & 3;
  let k1 = 0;

  if (remainder >= 3) k1 ^= data[tail + 2]! << 16;
  if (remainder >= 2) k1 ^= data[tail + 1]! << 8;
  if (remainder >= 1) {
    k1 ^= data[tail]!;
    k1 = Math.imul(k1, C1);
    k1 = (k1 << 15) | (k1 >>> 17);
    k1 = Math.imul(k1, C2);
    h1 ^= k1;
  }

  // Finalisation mix.
  h1 ^= length;
  h1 ^= h1 >>> 16;
  h1 = Math.imul(h1, 0x85eb_ca6b);
  h1 ^= h1 >>> 13;
  h1 = Math.imul(h1, 0xc2b2_ae35);
  h1 ^= h1 >>> 16;

  return h1 >>> 0;
}

/** Number of distinct buckets a subject can land in. Basis points, so 0.01% granularity. */
export const BUCKET_COUNT = 10_000;

/**
 * Maps a subject to a stable bucket in `[0, BUCKET_COUNT)`.
 *
 * The salt separates independent rollouts: the same user gets an uncorrelated
 * bucket per flag, so being in the unlucky tail of one experiment does not put
 * them in the tail of every other.
 */
export function bucketOf(salt: string, targetingKey: string): number {
  return murmurHash3(`${salt}:${targetingKey}`) % BUCKET_COUNT;
}
