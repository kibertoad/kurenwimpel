/**
 * The client's runtime guards: the typed getters' success and mismatch paths,
 * the context merge's clearing rule, closing a provider that has no close, and
 * the exact shape an impression event carries. `client.test.ts` proves the
 * lifecycle; this file pins the coercions around it.
 */

import { describe, expect, it, vi } from 'vitest';

import { FeatureFlagClient, StaticProvider } from '../../src/index.js';
import type { FlagDefinition, FlagProvider, ImpressionEvent } from '../../src/index.js';

const flags: FlagDefinition[] = [
  {
    key: 'retry-limit',
    enabled: true,
    variants: { standard: 3, aggressive: 10 },
    defaultVariant: 'standard',
    offVariant: 'standard',
  },
  {
    key: 'rate-limit',
    enabled: true,
    variants: { standard: { perMinute: 60 } },
    defaultVariant: 'standard',
    offVariant: 'standard',
  },
  {
    key: 'greeting',
    enabled: true,
    variants: { casual: 'Hey' },
    defaultVariant: 'casual',
    offVariant: 'casual',
  },
];

async function makeClient(extra: FlagDefinition[] = []): Promise<FeatureFlagClient> {
  const client = new FeatureFlagClient({ provider: new StaticProvider([...flags, ...extra]) });
  await client.init();
  return client;
}

describe('the typed getters serve their type and only their type', () => {
  it('serves a number through getNumber and its details twin', async () => {
    const client = await makeClient();

    expect(client.getNumber('retry-limit', 1)).toBe(3);
    expect(client.getNumberDetails('retry-limit', 1)).toMatchObject({
      value: 3,
      variant: 'standard',
      reason: 'STATIC',
    });
  });

  it('serves an object through getObject and rejects an array standing in for one', async () => {
    // Hand-built definitions bypass the parser, so the array exclusion is a
    // runtime guard, not a type.
    const arrayFlag = {
      key: 'broken-object',
      enabled: true,
      variants: { list: ['a', 'b'] },
      defaultVariant: 'list',
      offVariant: 'list',
    } as unknown as FlagDefinition;
    const client = await makeClient([arrayFlag]);

    expect(client.getObject('rate-limit', { perMinute: 1 })).toEqual({ perMinute: 60 });

    const details = client.getObjectDetails('broken-object', { fallback: true });
    expect(details.value).toEqual({ fallback: true });
    expect(details.errorCode).toBe('TYPE_MISMATCH');
  });

  it('serves a string and falls back across every type mismatch direction', async () => {
    const client = await makeClient();

    expect(client.getString('greeting', 'fallback')).toBe('Hey');
    expect(client.getBoolean('greeting', true)).toBe(true);
    expect(client.getBooleanDetails('greeting', true).errorCode).toBe('TYPE_MISMATCH');
    expect(client.getString('retry-limit', 'fallback')).toBe('fallback');
    expect(client.getNumberDetails('greeting', 9).value).toBe(9);
  });
});

describe('closing a provider that declares no close', () => {
  it('resolves without inventing an error to report', async () => {
    const onError = vi.fn();
    const closeless: FlagProvider = {
      name: 'closeless',
      load: () => new StaticProvider(flags).load(),
    };
    const client = new FeatureFlagClient({ provider: closeless, onError });
    await client.init();

    await client.close();
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('a per-call attribute set to undefined clears the default', () => {
  it('makes the attribute absent, not inherited and not present-with-undefined', async () => {
    const staged: FlagDefinition = {
      key: 'staged',
      enabled: true,
      variants: { on: true, off: false },
      defaultVariant: 'off',
      offVariant: 'off',
      rules: [
        {
          id: 'has-stage',
          conditions: [{ attribute: 'stage', operator: 'exists' }],
          variant: 'on',
        },
      ],
    };
    const client = new FeatureFlagClient({
      provider: new StaticProvider([staged]),
      defaultContext: { stage: 'prod' },
    });
    await client.init();

    expect(client.getBoolean('staged', false)).toBe(true);
    expect(client.getBoolean('staged', false, { stage: undefined })).toBe(false);
    expect(client.getBoolean('staged', false, { other: 'x' })).toBe(true);
  });
});

describe('the exact shape of an impression event', () => {
  const experiment: FlagDefinition = {
    key: 'experiment',
    enabled: true,
    variants: { on: true, off: false },
    defaultVariant: 'off',
    offVariant: 'off',
    version: 7,
    metadata: { team: 'growth' },
    rules: [{ id: 'everyone', conditions: [], variant: 'on' }],
  };

  it('carries every optional field that applies, and none that do not', async () => {
    const events: ImpressionEvent[] = [];
    const client = new FeatureFlagClient({
      provider: new StaticProvider([experiment, ...flags]),
      onImpression: (event) => events.push(event),
    });
    await client.init();

    client.getBoolean('experiment', false, { targetingKey: 'u1' });
    const { timestamp, ...event } = events[0]!;

    expect(typeof timestamp).toBe('number');
    // Exact: a field appearing present-with-undefined would serialise as an
    // explicit null-ish key on whatever feed consumes this.
    expect(event).toStrictEqual({
      flagKey: 'experiment',
      value: true,
      variant: 'on',
      reason: 'TARGETING_MATCH',
      ruleId: 'everyone',
      targetingKey: 'u1',
      flagVersion: 7,
      metadata: { team: 'growth' },
    });

    client.getNumber('retry-limit', 1);
    const plain = events[1]!;
    expect(plain).not.toHaveProperty('ruleId');
    expect(plain).not.toHaveProperty('errorCode');
    expect(plain).not.toHaveProperty('targetingKey');
    expect(plain).not.toHaveProperty('flagVersion');
    expect(plain).not.toHaveProperty('metadata');
  });
});
