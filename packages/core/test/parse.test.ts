import { describe, expect, it } from 'vitest';

import { FlagParseError, parseFlagDefinition, parseFlagDefinitions } from '../src/index.js';

const valid = {
  key: 'new-checkout',
  enabled: true,
  variants: { on: true, off: false },
  defaultVariant: 'off',
  offVariant: 'off',
};

describe('parseFlagDefinition', () => {
  it('accepts a minimal definition', () => {
    expect(parseFlagDefinition(valid)).toEqual(valid);
  });

  it('keeps optional fields only when present', () => {
    const parsed = parseFlagDefinition(valid);
    expect(Object.hasOwn(parsed, 'rules')).toBe(false);
    expect(Object.hasOwn(parsed, 'salt')).toBe(false);
  });

  it('parses rules, conditions, and rollouts', () => {
    const parsed = parseFlagDefinition({
      ...valid,
      salt: 'v2',
      version: 3,
      rules: [
        {
          id: 'beta-testers',
          conditions: [
            { attribute: 'plan', operator: 'in', value: ['pro', 'enterprise'] },
            { attribute: 'seats', operator: 'gte', value: 10 },
            { attribute: 'email', operator: 'endsWith', value: '@lokalise.com' },
            { attribute: 'deleted', operator: 'notExists' },
          ],
          rollout: [
            { variant: 'on', weight: 50 },
            { variant: 'off', weight: 50 },
          ],
        },
      ],
    });

    expect(parsed.salt).toBe('v2');
    expect(parsed.version).toBe(3);
    expect(parsed.rules?.[0]?.conditions).toHaveLength(4);
    expect(parsed.rules?.[0]?.rollout).toHaveLength(2);
  });

  it.each([
    ['a non-object', 42],
    ['a missing key', { ...valid, key: undefined }],
    ['an empty key', { ...valid, key: '' }],
    ['a non-boolean enabled', { ...valid, enabled: 'yes' }],
    ['missing variants', { ...valid, variants: undefined }],
    ['empty variants', { ...valid, variants: {} }],
    ['a dangling defaultVariant', { ...valid, defaultVariant: 'nope' }],
    ['a dangling offVariant', { ...valid, offVariant: 'nope' }],
  ])('rejects %s', (_label, input) => {
    expect(() => parseFlagDefinition(input)).toThrow(FlagParseError);
  });

  it('rejects a rule that serves nothing', () => {
    expect(() => parseFlagDefinition({ ...valid, rules: [{ id: 'r', conditions: [] }] })).toThrow(
      /must declare a variant or a rollout/u,
    );
  });

  it('rejects a rule pointing at an unknown variant', () => {
    expect(() =>
      parseFlagDefinition({ ...valid, rules: [{ id: 'r', conditions: [], variant: 'ghost' }] }),
    ).toThrow(/unknown variant/u);
  });

  it('rejects an unsupported operator', () => {
    expect(() =>
      parseFlagDefinition({
        ...valid,
        rules: [
          {
            id: 'r',
            conditions: [{ attribute: 'a', operator: 'regex', value: '.*' }],
            variant: 'on',
          },
        ],
      }),
    ).toThrow(/unsupported operator/u);
  });

  it('rejects an operator whose value has the wrong type', () => {
    expect(() =>
      parseFlagDefinition({
        ...valid,
        rules: [
          {
            id: 'r',
            conditions: [{ attribute: 'a', operator: 'gt', value: 'ten' }],
            variant: 'on',
          },
        ],
      }),
    ).toThrow(/needs a finite number/u);

    expect(() =>
      parseFlagDefinition({
        ...valid,
        rules: [
          {
            id: 'r',
            conditions: [{ attribute: 'a', operator: 'in', value: 'pro' }],
            variant: 'on',
          },
        ],
      }),
    ).toThrow(/needs an array/u);
  });

  it('rejects a negative rollout weight', () => {
    expect(() =>
      parseFlagDefinition({ ...valid, rollout: [{ variant: 'on', weight: -1 }] }),
    ).toThrow(/non-negative/u);
  });

  it('drops an empty rollout array rather than producing an unservable split', () => {
    expect(parseFlagDefinition({ ...valid, rollout: [] }).rollout).toBeUndefined();
  });
});

describe('parseFlagDefinitions', () => {
  it('reads an array', () => {
    const { flags, issues } = parseFlagDefinitions([valid]);
    expect(flags).toHaveLength(1);
    expect(issues).toEqual([]);
  });

  it('reads a key-to-definition object', () => {
    const { flags, issues } = parseFlagDefinitions({ 'new-checkout': valid });
    expect(flags[0]?.key).toBe('new-checkout');
    expect(issues).toEqual([]);
  });

  it('keeps the good flags and isolates the bad ones', () => {
    const { flags, issues } = parseFlagDefinitions([
      valid,
      { key: 'broken', enabled: 'nope' },
      { ...valid, key: 'other' },
    ]);

    expect(flags.map((flag) => flag.key)).toEqual(['new-checkout', 'other']);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.at).toBe('broken');
  });

  it('reports a root-level shape error', () => {
    const { flags, issues } = parseFlagDefinitions('not flags');
    expect(flags).toEqual([]);
    expect(issues[0]?.at).toBe('root');
  });

  it('returns nothing for an empty batch', () => {
    expect(parseFlagDefinitions([])).toEqual({ flags: [], issues: [] });
  });
});
