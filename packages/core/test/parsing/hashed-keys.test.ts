import { describe, expect, it } from 'vitest';

import {
  FlagParseError,
  parseFlagDefinition,
  parseSegmentDefinition,
  sha256Hex,
} from '../../src/index.js';

const DIGEST = sha256Hex('user-1');
const OTHER = sha256Hex('user-2');

function flagWithTargets(targets: unknown): unknown {
  return {
    key: 'f',
    enabled: true,
    variants: { on: true, off: false },
    defaultVariant: 'off',
    offVariant: 'off',
    targets,
  };
}

describe('hashed segment lists', () => {
  it('accepts a segment holding only digests', () => {
    const segment = {
      key: 's',
      includedHashes: { algorithm: 'sha256', values: [DIGEST] },
      excludedHashes: { algorithm: 'sha256', values: [OTHER] },
    };
    expect(parseSegmentDefinition(segment)).toEqual(segment);
  });

  it('copies the digest list rather than aliasing it', () => {
    const values = [DIGEST];
    const parsed = parseSegmentDefinition({
      key: 's',
      includedHashes: { algorithm: 'sha256', values },
    });
    values.push(OTHER);
    expect(parsed.includedHashes?.values).toEqual([DIGEST]);
  });

  it.each([
    ['a non-object list', ['abc'], /includedHashes must be an object/u],
    ['a missing algorithm', { values: [DIGEST] }, /algorithm must be "sha256"/u],
    ['another algorithm', { algorithm: 'md5', values: [DIGEST] }, /algorithm must be "sha256"/u],
    [
      'values that are not a list',
      { algorithm: 'sha256', values: DIGEST },
      /values must be an array/u,
    ],
    ['an uppercase digest', { algorithm: 'sha256', values: [DIGEST.toUpperCase()] }, /value 0/u],
    ['a short digest', { algorithm: 'sha256', values: [DIGEST.slice(1)] }, /value 0/u],
    ['a long digest', { algorithm: 'sha256', values: [`${DIGEST}0`] }, /value 0/u],
    ['a non-hex digest', { algorithm: 'sha256', values: [`${DIGEST.slice(1)}g`] }, /value 0/u],
    ['a plain key', { algorithm: 'sha256', values: [DIGEST, 'user-1'] }, /value 1/u],
    ['a number', { algorithm: 'sha256', values: [42] }, /value 0/u],
  ])('rejects %s', (_label, includedHashes, message) => {
    expect(() => parseSegmentDefinition({ key: 's', includedHashes })).toThrow(FlagParseError);
    expect(() => parseSegmentDefinition({ key: 's', includedHashes })).toThrow(message);
  });

  it('counts an empty digest list as no criteria', () => {
    const empty = { key: 's', includedHashes: { algorithm: 'sha256', values: [] } };
    expect(() => parseSegmentDefinition(empty)).toThrow(/needs a non-empty/u);
  });
});

describe('hashed targets', () => {
  it('accepts a target holding only digests', () => {
    const targets = [{ variant: 'on', keyHashes: { algorithm: 'sha256', values: [DIGEST] } }];
    expect(parseFlagDefinition(flagWithTargets(targets)).targets).toEqual(targets);
  });

  it('accepts keys and digests side by side', () => {
    const targets = [
      { variant: 'on', keys: ['qa'], keyHashes: { algorithm: 'sha256', values: [DIGEST] } },
    ];
    expect(parseFlagDefinition(flagWithTargets(targets)).targets).toEqual(targets);
  });

  it('still requires keys from a target without digests', () => {
    expect(() => parseFlagDefinition(flagWithTargets([{ variant: 'on' }]))).toThrow(
      /target on keys must be an array of strings/u,
    );
  });

  it('rejects a digest repeated inside one target', () => {
    const targets = [
      { variant: 'on', keyHashes: { algorithm: 'sha256', values: [DIGEST, DIGEST] } },
    ];
    expect(() => parseFlagDefinition(flagWithTargets(targets))).toThrow(
      /target on lists key hash ".*" more than once/u,
    );
  });

  it('rejects a digest claimed by two targets', () => {
    const list = { algorithm: 'sha256', values: [DIGEST] };
    const targets = [
      { variant: 'on', keyHashes: list },
      { variant: 'off', keyHashes: list },
    ];
    expect(() => parseFlagDefinition(flagWithTargets(targets))).toThrow(
      /key hash ".*" appears in more than one target/u,
    );
  });

  it('rejects a malformed digest', () => {
    const targets = [{ variant: 'on', keyHashes: { algorithm: 'sha256', values: ['abc'] } }];
    expect(() => parseFlagDefinition(flagWithTargets(targets))).toThrow(
      /target on keyHashes: value 0 must be a SHA-256 digest/u,
    );
  });
});
