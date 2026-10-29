import { describe, expect, it } from 'vitest';

import { canonicalJson, matchesEtag } from '../src/etag.js';

describe('canonicalJson', () => {
  it('sorts keys at every depth and keeps array order', () => {
    expect(canonicalJson({ b: [2, { d: 1, c: null }], a: 'x' })).toBe(
      '{"a":"x","b":[2,{"c":null,"d":1}]}',
    );
  });

  it('escapes keys and keeps a __proto__ key as data', () => {
    const parsed: unknown = JSON.parse('{"__proto__":{"x":1},"q\\"":true}');

    expect(canonicalJson(parsed)).toBe('{"__proto__":{"x":1},"q\\"":true}');
  });

  it('writes a missing value as null', () => {
    expect(canonicalJson([() => 1])).toBe('[null]');
  });
});

describe('matchesEtag', () => {
  it.each([
    [null, false],
    ['"b"', false],
    ['"a"', true],
    ['W/"a"', true],
    ['"b", "a"', true],
    ['*', true],
  ])('%s against "a" is %s', (header, expected) => {
    expect(matchesEtag(header, '"a"')).toBe(expected);
  });
});
