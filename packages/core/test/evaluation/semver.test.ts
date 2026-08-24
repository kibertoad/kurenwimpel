import { describe, expect, it } from 'vitest';

import { compareVersions, parseVersion } from '../../src/index.js';

describe('parseVersion', () => {
  it('parses a full version', () => {
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
  });

  it('tolerates a leading v and a short core', () => {
    expect(parseVersion('v2')).toEqual({ major: 2, minor: 0, patch: 0, prerelease: [] });
    expect(parseVersion('2.1')).toEqual({ major: 2, minor: 1, patch: 0, prerelease: [] });
  });

  it('splits prerelease identifiers and keeps numeric ones as numbers', () => {
    expect(parseVersion('1.0.0-alpha.7')?.prerelease).toEqual(['alpha', 7]);
  });

  it('ignores build metadata', () => {
    expect(parseVersion('1.0.0+build.5')).toEqual(parseVersion('1.0.0'));
  });

  it.each(['', 'not-a-version', '1.2.3.4', '1.x', 'v'])('rejects %j', (input) => {
    expect(parseVersion(input)).toBeUndefined();
  });
});

const inOrder = (lower: string, higher: string): void => {
  expect(compareVersions(lower, higher)).toBeLessThan(0);
  expect(compareVersions(higher, lower)).toBeGreaterThan(0);
};

describe('compareVersions', () => {
  it('orders the numeric core', () => {
    inOrder('1.9.9', '2.0.0');
    inOrder('2.1.0', '2.10.0');
    inOrder('2.1.1', '2.1.2');
  });

  it('treats a short core as zero-padded', () => {
    expect(compareVersions('2', '2.0.0')).toBe(0);
    expect(compareVersions('v2.1', '2.1.0')).toBe(0);
  });

  it('ranks a prerelease below its release', () => {
    inOrder('1.0.0-rc.1', '1.0.0');
  });

  it('orders prereleases per SemVer 2.0.0', () => {
    // The spec's own example chain.
    inOrder('1.0.0-alpha', '1.0.0-alpha.1');
    inOrder('1.0.0-alpha.1', '1.0.0-alpha.beta');
    inOrder('1.0.0-alpha.beta', '1.0.0-beta');
    inOrder('1.0.0-beta.2', '1.0.0-beta.11');
    inOrder('1.0.0-beta.11', '1.0.0-rc.1');
  });

  it('returns undefined when either side is not a version', () => {
    expect(compareVersions('oops', '1.0.0')).toBeUndefined();
    expect(compareVersions('1.0.0', 'oops')).toBeUndefined();
  });
});
