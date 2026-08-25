/**
 * The parser's edges: the exact bounds of what a field accepts, which absent
 * shapes read as absent, and what a parsed definition carries — as opposed to
 * `flag.test.ts`, which proves the shapes a control plane actually ships.
 */

import { describe, expect, it } from 'vitest';

import { parseFlagDefinition } from '../../src/index.js';
import type { FlagParseIssue } from '../../src/index.js';

const minimal = {
  key: 'checkout',
  enabled: true,
  variants: { on: true, off: false },
  defaultVariant: 'off',
  offVariant: 'off',
};

describe('a parsed definition carries only the fields it was given', () => {
  it('leaves every optional field off, not present-with-undefined', () => {
    const parsed = parseFlagDefinition(minimal);

    for (const field of [
      'prerequisites',
      'targets',
      'allocation',
      'rules',
      'rollout',
      'metadata',
      'salt',
      'version',
    ]) {
      expect(parsed).not.toHaveProperty(field);
    }
  });

  it('leaves bucketBy and seed off an allocation that never set them', () => {
    const parsed = parseFlagDefinition({ ...minimal, allocation: { percent: 25 } });

    expect(parsed.allocation).toEqual({ percent: 25 });
    expect(parsed.allocation).not.toHaveProperty('bucketBy');
    expect(parsed.allocation).not.toHaveProperty('seed');
  });
});

describe('the allocation percent bounds', () => {
  it('accepts both closed ends of the range', () => {
    expect(parseFlagDefinition({ ...minimal, allocation: { percent: 0 } }).allocation).toEqual({
      percent: 0,
    });
    expect(parseFlagDefinition({ ...minimal, allocation: { percent: 100 } }).allocation).toEqual({
      percent: 100,
    });
  });

  it('rejects a percent just past either end, and a non-numeric one', () => {
    expect(() => parseFlagDefinition({ ...minimal, allocation: { percent: -0.01 } })).toThrow(
      /between 0 and 100/u,
    );
    expect(() => parseFlagDefinition({ ...minimal, allocation: { percent: 100.01 } })).toThrow(
      /between 0 and 100/u,
    );
    expect(() => parseFlagDefinition({ ...minimal, allocation: { percent: '50' } })).toThrow(
      /finite number/u,
    );
  });

  it('rejects an allocation that is not an object', () => {
    expect(() => parseFlagDefinition({ ...minimal, allocation: 50 })).toThrow(
      /allocation must be an object/u,
    );
  });
});

describe('the variants field at its edges', () => {
  it('says a flag with no variants needs one, not that its default is unknown', () => {
    expect(() => parseFlagDefinition({ ...minimal, variants: {} })).toThrow(
      /at least one variant/u,
    );
  });

  it('rejects a non-finite number variant like every other numeric field', () => {
    expect(() =>
      parseFlagDefinition({ ...minimal, variants: { on: Number.NaN, off: false } }),
    ).toThrow(/finite number/u);
    expect(() =>
      parseFlagDefinition({ ...minimal, variants: { on: Number.POSITIVE_INFINITY, off: false } }),
    ).toThrow(/finite number/u);
  });
});

describe('the version field stays tolerant without going quiet', () => {
  it('drops a NaN version with a warning: NaN is not a version label', () => {
    const warnings: FlagParseIssue[] = [];
    const parsed = parseFlagDefinition({ ...minimal, version: Number.NaN }, warnings);

    expect(parsed).not.toHaveProperty('version');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain('version');
  });

  it('warns nothing about a version that was simply not set', () => {
    const warnings: FlagParseIssue[] = [];
    parseFlagDefinition(minimal, warnings);
    parseFlagDefinition({ ...minimal, version: null }, warnings);

    expect(warnings).toEqual([]);
  });

  it('survives a malformed version when no warnings collector was passed', () => {
    expect(parseFlagDefinition({ ...minimal, version: 'v3' })).not.toHaveProperty('version');
  });
});

describe('rules and prerequisites at their shape edges', () => {
  it('survives a dropped rule when no warnings collector was passed', () => {
    const parsed = parseFlagDefinition({
      ...minimal,
      rules: [{ id: 'future', conditions: [{ operator: 'matchesGlob' }], variant: 'on' }],
    });

    expect(parsed.rules).toEqual([]);
  });

  it('rejects rules that are not an array, and a rule that is not an object', () => {
    expect(() => parseFlagDefinition({ ...minimal, rules: {} })).toThrow(/rules must be an array/u);
    expect(() => parseFlagDefinition({ ...minimal, rules: ['always-on'] })).toThrow(
      /rule 0 must be an object/u,
    );
  });

  it('rejects a prerequisite with an empty variant list', () => {
    expect(() =>
      parseFlagDefinition({ ...minimal, prerequisites: [{ flag: 'base', variants: [] }] }),
    ).toThrow(/at least one variant/u);
  });

  it('rejects prerequisites that are not an array, and one that is not an object', () => {
    expect(() => parseFlagDefinition({ ...minimal, prerequisites: {} })).toThrow(
      /prerequisites must be an array/u,
    );
    expect(() => parseFlagDefinition({ ...minimal, prerequisites: ['base'] })).toThrow(
      /prerequisite 0 must be an object/u,
    );
  });

  it('rejects targets that are not an array, and a target that is not an object', () => {
    expect(() => parseFlagDefinition({ ...minimal, targets: {} })).toThrow(
      /targets must be an array/u,
    );
    expect(() => parseFlagDefinition({ ...minimal, targets: [null] })).toThrow(
      /target 0 must be an object/u,
    );
  });
});
