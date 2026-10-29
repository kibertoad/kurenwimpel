/// <reference types="node" />
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { sha256Hex } from '../../src/index.js';

function nodeSha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

describe('sha256Hex', () => {
  it('matches the FIPS 180-4 examples', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('agrees with node:crypto across every padding boundary', () => {
    for (let length = 0; length <= 200; length++) {
      const input = 'k'.repeat(length);
      expect(sha256Hex(input), `length ${length}`).toBe(nodeSha256(input));
    }
  });

  it('agrees with node:crypto on multi-byte and astral characters', () => {
    for (const input of ['user-ü', 'Ω≈ç√', '日本語のキー', '🚀user', 'a😀b😀c', 'ß'.repeat(70)]) {
      expect(sha256Hex(input), input).toBe(nodeSha256(input));
    }
  });

  it('encodes a lone surrogate as U+FFFD, as node:crypto does', () => {
    for (const input of ['\uD800', 'x\uDC00y', 'end\uD83D']) {
      expect(sha256Hex(input)).toBe(nodeSha256(input));
    }
  });

  it('agrees with node:crypto on typical targeting keys', () => {
    for (let index = 0; index < 500; index++) {
      const input = `user-${index * 7919}@tenant-${index % 13}`;
      expect(sha256Hex(input)).toBe(nodeSha256(input));
    }
  });
});
