/**
 * SHA-256 (FIPS 180-4) in plain TypeScript, synchronous and allocation-light.
 *
 * Core has no platform APIs to lean on: `node:crypto` is Node-only and Web
 * Crypto's `digest` is asynchronous, which evaluation cannot be.
 */

// `| 0` wraps a sum to int32, which keeps the round variables small integers.
// `Math.trunc` does not wrap, and `>>> 0` turns them into doubles.
/* oxlint-disable unicorn/prefer-math-trunc */

const ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const INITIAL_STATE = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
] as const;

const HEX_BYTES = Array.from({ length: 256 }, (_unused, byte) =>
  byte.toString(16).padStart(2, '0'),
);

const schedule = new Uint32Array(64);
const state = new Uint32Array(8);

/** The SHA-256 digest of a string's UTF-8 encoding, as 64 lowercase hex characters. */
export function sha256Hex(input: string): string {
  const message = paddedUtf8(input);
  state.set(INITIAL_STATE);

  for (let offset = 0; offset < message.length; offset += 64) {
    compress(message, offset);
  }

  let hex = '';
  for (const word of state) {
    hex +=
      (HEX_BYTES[word >>> 24] ?? '') +
      (HEX_BYTES[(word >>> 16) & 0xff] ?? '') +
      (HEX_BYTES[(word >>> 8) & 0xff] ?? '') +
      (HEX_BYTES[word & 0xff] ?? '');
  }
  return hex;
}

/**
 * The UTF-8 bytes of `input`, padded to a whole number of 64-byte blocks with
 * the trailing bit and the 64-bit message length. A lone surrogate encodes as
 * U+FFFD, which is what `TextEncoder` and Node's `Buffer` both do.
 */
function paddedUtf8(input: string): Uint8Array {
  const bytes = new Uint8Array(Math.ceil((input.length * 3 + 9) / 64) * 64);
  let length = 0;

  for (let index = 0; index < input.length; index++) {
    let code = input.codePointAt(index) ?? 0;
    if (code > 0xffff) index++;
    else if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
    length = writeCodePoint(bytes, length, code);
  }

  const blocks = Math.ceil((length + 9) / 64);
  const end = blocks * 64;
  bytes[length] = 0x80;

  const bits = length * 8;
  const view = new DataView(bytes.buffer);
  view.setUint32(end - 8, Math.floor(bits / 0x1_0000_0000));
  view.setUint32(end - 4, bits >>> 0);
  return bytes.subarray(0, end);
}

function writeCodePoint(bytes: Uint8Array, at: number, code: number): number {
  if (code < 0x80) {
    bytes[at] = code;
    return at + 1;
  }
  if (code < 0x800) {
    bytes[at] = 0xc0 | (code >>> 6);
    bytes[at + 1] = 0x80 | (code & 0x3f);
    return at + 2;
  }
  if (code < 0x1_0000) {
    bytes[at] = 0xe0 | (code >>> 12);
    bytes[at + 1] = 0x80 | ((code >>> 6) & 0x3f);
    bytes[at + 2] = 0x80 | (code & 0x3f);
    return at + 3;
  }
  bytes[at] = 0xf0 | (code >>> 18);
  bytes[at + 1] = 0x80 | ((code >>> 12) & 0x3f);
  bytes[at + 2] = 0x80 | ((code >>> 6) & 0x3f);
  bytes[at + 3] = 0x80 | (code & 0x3f);
  return at + 4;
}

function rotr(word: number, bits: number): number {
  return (word >>> bits) | (word << (32 - bits));
}

/** One 64-byte block folded into {@link state}. */
function compress(message: Uint8Array, offset: number): void {
  for (let index = 0; index < 16; index++) {
    const at = offset + index * 4;
    schedule[index] =
      ((message[at] ?? 0) << 24) |
      ((message[at + 1] ?? 0) << 16) |
      ((message[at + 2] ?? 0) << 8) |
      (message[at + 3] ?? 0);
  }
  for (let index = 16; index < 64; index++) {
    const w15 = schedule[index - 15] ?? 0;
    const w2 = schedule[index - 2] ?? 0;
    const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
    const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
    schedule[index] = (schedule[index - 16] ?? 0) + s0 + (schedule[index - 7] ?? 0) + s1;
  }

  let [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0] = state;

  for (let index = 0; index < 64; index++) {
    const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
    const choice = (e & f) ^ (~e & g);
    const t1 = (h + s1 + choice + (ROUND_CONSTANTS[index] ?? 0) + (schedule[index] ?? 0)) | 0;
    const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
    const majority = (a & b) ^ (a & c) ^ (b & c);
    const t2 = (s0 + majority) | 0;
    h = g;
    g = f;
    f = e;
    e = (d + t1) | 0;
    d = c;
    c = b;
    b = a;
    a = (t1 + t2) | 0;
  }

  state[0] = (state[0] ?? 0) + a;
  state[1] = (state[1] ?? 0) + b;
  state[2] = (state[2] ?? 0) + c;
  state[3] = (state[3] ?? 0) + d;
  state[4] = (state[4] ?? 0) + e;
  state[5] = (state[5] ?? 0) + f;
  state[6] = (state[6] ?? 0) + g;
  state[7] = (state[7] ?? 0) + h;
}
