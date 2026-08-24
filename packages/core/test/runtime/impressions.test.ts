import { describe, expect, it, vi } from 'vitest';

import { FeatureFlagClient, StaticProvider } from '../../src/index.js';
import type { FlagDefinition, ImpressionEvent } from '../../src/index.js';

const experiment: FlagDefinition = {
  key: 'checkout-experiment',
  enabled: true,
  variants: { treatment: true, control: false },
  defaultVariant: 'control',
  offVariant: 'control',
  version: 7,
  metadata: { experiment: 'checkout-q3' },
  rollout: [
    { variant: 'treatment', weight: 50 },
    { variant: 'control', weight: 50 },
  ],
};

const toggle: FlagDefinition = {
  key: 'plain-toggle',
  enabled: true,
  variants: { on: true, off: false },
  defaultVariant: 'on',
  offVariant: 'off',
};

async function makeClient(
  onImpression: (event: ImpressionEvent) => void,
  onError?: (error: Error) => void,
): Promise<FeatureFlagClient> {
  const client = new FeatureFlagClient({
    provider: new StaticProvider([experiment, toggle]),
    onImpression,
    ...(onError === undefined ? {} : { onError }),
  });
  await client.init();
  return client;
}

describe('impressions', () => {
  it('emits exactly one event per typed getter call, with the full exposure record', async () => {
    const seen: ImpressionEvent[] = [];
    const client = await makeClient((event) => seen.push(event));

    const value = client.getBoolean('checkout-experiment', false, { targetingKey: 'user-1' });

    expect(seen).toHaveLength(1);
    const event = seen[0]!;
    expect(event).toMatchObject({
      flagKey: 'checkout-experiment',
      value,
      reason: 'SPLIT',
      targetingKey: 'user-1',
      flagVersion: 7,
      metadata: { experiment: 'checkout-q3' },
    });
    expect(event.variant === 'treatment' || event.variant === 'control').toBe(true);
    expect(event.timestamp).toBeGreaterThan(0);
  });

  it('emits for raw evaluate calls and carries error codes on failures', async () => {
    const seen: ImpressionEvent[] = [];
    const client = await makeClient((event) => seen.push(event));

    client.evaluate('checkout-experiment', { targetingKey: 'user-1' });
    client.getBoolean('no-such-flag', false);

    expect(seen).toHaveLength(2);
    expect(seen[1]).toMatchObject({ flagKey: 'no-such-flag', errorCode: 'FLAG_NOT_FOUND' });
  });

  it('reports the served value, not the raw one, when a typed getter falls back', async () => {
    const seen: ImpressionEvent[] = [];
    const client = await makeClient((event) => seen.push(event));

    // Force a mismatch by asking the boolean experiment flag for a string.
    const details = client.getStringDetails('checkout-experiment', 'fallback', {
      targetingKey: 'user-1',
    });

    expect(details.value).toBe('fallback');
    expect(details.errorCode).toBe('TYPE_MISMATCH');
    // The mismatch must not strip the exposure record of its experiment join
    // keys: metadata, variant, and version all survive.
    expect(details.metadata).toEqual({ experiment: 'checkout-q3' });
    expect(seen[0]).toMatchObject({
      value: 'fallback',
      errorCode: 'TYPE_MISMATCH',
      metadata: { experiment: 'checkout-q3' },
      flagVersion: 7,
    });
  });

  it('never lets a throwing hook fail the evaluation, and reports it', async () => {
    const onError = vi.fn();
    const client = await makeClient(() => {
      throw new Error('analytics down');
    }, onError);

    expect(client.getBoolean('plain-toggle', false)).toBe(true);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[1]).toMatchObject({ operation: 'impression' });
  });
});

describe('evaluateAll', () => {
  it('evaluates every flag in the snapshot against one context', async () => {
    const client = new FeatureFlagClient({ provider: new StaticProvider([experiment, toggle]) });
    await client.init();

    const results = client.evaluateAll({ targetingKey: 'user-1' });

    expect(results.map((result) => result.key).toSorted()).toEqual([
      'checkout-experiment',
      'plain-toggle',
    ]);
    expect(results.every((result) => result.value !== undefined)).toBe(true);
  });

  it('refuses to answer before the first load instead of reporting no flags', () => {
    // A bulk body has no per-flag slot for PROVIDER_NOT_READY, and an empty
    // array reads exactly like a healthy empty ruleset — the caller has to be
    // able to turn this into a 5xx rather than a 200 with nothing in it.
    const client = new FeatureFlagClient({ provider: new StaticProvider([toggle]) });

    expect(() => client.evaluateAll({ targetingKey: 'user-1' })).toThrow(/has not loaded flags/u);
    expect(client.ready).toBe(false);
  });

  it('emits no impressions by default: a bulk fetch is not an exposure', async () => {
    const seen: ImpressionEvent[] = [];
    const client = await makeClient((event) => seen.push(event));

    client.evaluateAll({ targetingKey: 'user-1' });

    expect(seen).toEqual([]);
  });

  it('emits one impression per flag when the caller asks for them', async () => {
    const seen: ImpressionEvent[] = [];
    const client = await makeClient((event) => seen.push(event));

    client.evaluateAll({ targetingKey: 'user-1' }, { impressions: true });

    expect(seen.map((event) => event.flagKey).toSorted()).toEqual([
      'checkout-experiment',
      'plain-toggle',
    ]);
  });
});
