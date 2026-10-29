import { describe, expect, it } from 'vitest';

import {
  evaluateFlag,
  FeatureFlagClient,
  parseFlagDefinition,
  parseRuleset,
  StaticProvider,
} from '../../src/index.js';
import type { FlagParseIssue } from '../../src/index.js';

const flag = {
  key: 'new-checkout',
  enabled: true,
  variants: { on: true, off: false },
  defaultVariant: 'on',
  offVariant: 'off',
  metadata: { experiment: 'checkout-q3' },
};

const lifecycle = {
  owner: 'team-checkout',
  kind: 'release',
  expiresOn: '2027-01-31',
  tags: ['checkout'],
};

function parseWithWarnings(raw: unknown): { lifecycle: unknown; warnings: string[] } {
  const warnings: FlagParseIssue[] = [];
  const parsed = parseFlagDefinition({ ...flag, lifecycle: raw }, warnings);
  return { lifecycle: parsed.lifecycle, warnings: warnings.map((warning) => warning.message) };
}

describe('the lifecycle block', () => {
  it('parses every field', () => {
    expect(parseFlagDefinition({ ...flag, lifecycle }).lifecycle).toEqual(lifecycle);
  });

  it('is absent when the definition has none, or null', () => {
    expect(Object.hasOwn(parseFlagDefinition(flag), 'lifecycle')).toBe(false);
    expect(Object.hasOwn(parseFlagDefinition({ ...flag, lifecycle: null }), 'lifecycle')).toBe(
      false,
    );
  });

  it('copies the tags rather than aliasing the payload', () => {
    const tags = ['checkout'];
    const parsed = parseFlagDefinition({ ...flag, lifecycle: { tags } });
    tags.push('later');
    expect(parsed.lifecycle?.tags).toEqual(['checkout']);
  });

  const date = 'expiresOn must be a calendar date written YYYY-MM-DD';
  const tagList = 'tags must be an array of non-empty strings';
  it.each([
    [{ kind: 'temporary' }, 'kind must be one of release, experiment, ops, permission'],
    [{ owner: '' }, 'owner must be a non-empty string'],
    [{ owner: 7 }, 'owner must be a non-empty string'],
    [{ expiresOn: '2027-02-30' }, date],
    [{ expiresOn: '31/01/2027' }, date],
    [{ expiresOn: 20_270_131 }, date],
    [{ tags: 'checkout' }, tagList],
    [{ tags: ['ok', ''] }, tagList],
  ])('drops only the bad field of %j and warns', (raw, message) => {
    const result = parseWithWarnings({ ...lifecycle, ...raw });
    expect(result.warnings).toEqual([
      `flag new-checkout: lifecycle ${message}, ignored; the flag is still served`,
    ]);
    const [field = ''] = Object.keys(raw);
    const kept = Object.fromEntries(Object.entries(lifecycle).filter(([name]) => name !== field));
    expect(result.lifecycle).toEqual(kept);
  });

  it('warns about a lifecycle that is not an object and keeps the flag', () => {
    const { flags, issues } = parseRuleset([{ ...flag, lifecycle: ['release'] }]);
    expect(flags.map((parsed) => parsed.key)).toEqual(['new-checkout']);
    expect(flags[0]?.lifecycle).toBeUndefined();
    expect(issues).toEqual([
      {
        at: 'new-checkout',
        message:
          'flag new-checkout: lifecycle must be an object, ignored; the flag is still served',
      },
    ]);
  });
});

describe('evaluation with a lifecycle block', () => {
  const parsed = parseFlagDefinition({ ...flag, lifecycle });

  it('never puts the lifecycle on a result', () => {
    const result = evaluateFlag(parsed, { targetingKey: 'user-1' });
    expect(result).toEqual({
      key: 'new-checkout',
      value: true,
      variant: 'on',
      reason: 'STATIC',
      metadata: { experiment: 'checkout-q3' },
    });
    expect(JSON.stringify(result)).not.toContain('team-checkout');
  });

  it('never puts the lifecycle on a client result', async () => {
    const client = new FeatureFlagClient({ provider: new StaticProvider([parsed]) });
    await client.init();
    const details = client.getBooleanDetails('new-checkout', false, { targetingKey: 'user-1' });
    expect(details.value).toBe(true);
    expect(JSON.stringify(details)).not.toContain('team-checkout');
    expect(JSON.stringify(client.evaluateAll({ targetingKey: 'user-1' }))).not.toContain(
      'team-checkout',
    );
  });
});
