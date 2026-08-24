import { describe, expect, it, vi } from 'vitest';

import {
  createSnapshot,
  FeatureFlagClient,
  StaticProvider,
  type FlagDefinition,
  type FlagProvider,
  type FlagSnapshot,
} from '../src/index.js';

const flags: FlagDefinition[] = [
  {
    key: 'new-checkout',
    enabled: true,
    variants: { on: true, off: false },
    defaultVariant: 'on',
    offVariant: 'off',
  },
  {
    key: 'greeting',
    enabled: true,
    variants: { formal: 'Good day', casual: 'Hey' },
    defaultVariant: 'casual',
    offVariant: 'formal',
  },
  {
    key: 'rate-limit',
    enabled: true,
    variants: { standard: { perMinute: 60 } },
    defaultVariant: 'standard',
    offVariant: 'standard',
  },
];

async function makeClient(overrides?: Partial<FlagDefinition>[]): Promise<FeatureFlagClient> {
  const definitions =
    overrides === undefined ? flags : [...flags, ...(overrides as FlagDefinition[])];
  const client = new FeatureFlagClient({ provider: new StaticProvider(definitions) });
  await client.init();
  return client;
}

describe('FeatureFlagClient', () => {
  it('is not ready before init and reports it on evaluation', () => {
    const client = new FeatureFlagClient({ provider: new StaticProvider(flags) });

    expect(client.ready).toBe(false);
    expect(client.getBoolean('new-checkout', false)).toBe(false);
    expect(client.getBooleanDetails('new-checkout', false).errorCode).toBe('PROVIDER_NOT_READY');
  });

  it('resolves typed values after init', async () => {
    const client = await makeClient();

    expect(client.getBoolean('new-checkout', false)).toBe(true);
    expect(client.getString('greeting', 'fallback')).toBe('Hey');
    expect(client.getObject('rate-limit', { perMinute: 1 })).toEqual({ perMinute: 60 });
  });

  it('falls back and reports FLAG_NOT_FOUND for unknown keys', async () => {
    const client = await makeClient();
    const details = client.getBooleanDetails('does-not-exist', true);

    expect(details.value).toBe(true);
    expect(details.errorCode).toBe('FLAG_NOT_FOUND');
    expect(details.reason).toBe('ERROR');
  });

  it('falls back on a type mismatch rather than returning the wrong shape', async () => {
    const client = await makeClient();
    const details = client.getBooleanDetails('greeting', false);

    expect(details.value).toBe(false);
    expect(details.errorCode).toBe('TYPE_MISMATCH');
  });

  it('rejects a non-finite number variant', async () => {
    const client = await makeClient([
      {
        key: 'broken-number',
        enabled: true,
        variants: { bad: Number.NaN },
        defaultVariant: 'bad',
        offVariant: 'bad',
      },
    ]);

    expect(client.getNumberDetails('broken-number', 5).errorCode).toBe('TYPE_MISMATCH');
  });

  it('merges default context under the per-call context', async () => {
    const provider = new StaticProvider([
      {
        key: 'regional',
        enabled: true,
        variants: { on: true, off: false },
        defaultVariant: 'off',
        offVariant: 'off',
        rules: [
          {
            id: 'eu-pro',
            conditions: [
              { attribute: 'region', operator: 'eq', value: 'eu' },
              { attribute: 'plan', operator: 'eq', value: 'pro' },
            ],
            variant: 'on',
          },
        ],
      },
    ]);

    const client = new FeatureFlagClient({
      provider,
      defaultContext: { attributes: { region: 'eu' } },
    });
    await client.init();

    expect(client.getBoolean('regional', false, { attributes: { plan: 'pro' } })).toBe(true);
    // Per-call attributes win over the defaults.
    expect(
      client.getBoolean('regional', false, { attributes: { plan: 'pro', region: 'us' } }),
    ).toBe(false);
  });

  it('applies the default context when no per-call context is given', async () => {
    const client = new FeatureFlagClient({
      provider: new StaticProvider([
        {
          key: 'staff',
          enabled: true,
          variants: { on: true, off: false },
          defaultVariant: 'off',
          offVariant: 'off',
          rules: [
            {
              id: 'internal',
              conditions: [{ attribute: 'service', operator: 'eq', value: 'billing' }],
              variant: 'on',
            },
          ],
        },
      ]),
      defaultContext: { attributes: { service: 'billing' } },
    });
    await client.init();

    expect(client.getBoolean('staff', false)).toBe(true);
  });

  it('installs a new snapshot on refresh', async () => {
    const provider = new StaticProvider(flags);
    const client = new FeatureFlagClient({ provider });
    await client.init();

    provider.replace(flags.map((flag) => ({ ...flag, enabled: false })));

    expect(await client.refresh()).toBe(true);
    expect(client.getBoolean('new-checkout', true)).toBe(false);
  });

  it('keeps the previous snapshot when the provider reports no change', async () => {
    const unchanging: FlagProvider = {
      name: 'unchanging',
      load: (previous?: FlagSnapshot) =>
        Promise.resolve(previous === undefined ? createSnapshot(flags) : null),
    };

    const client = new FeatureFlagClient({ provider: unchanging });
    await client.init();

    expect(await client.refresh()).toBe(false);
    expect(client.getBoolean('new-checkout', false)).toBe(true);
  });

  it('rethrows from init so a service fails to start on a bad control plane', async () => {
    const broken: FlagProvider = {
      name: 'broken',
      load: () => Promise.reject(new Error('control plane unreachable')),
    };

    await expect(new FeatureFlagClient({ provider: broken }).init()).rejects.toThrow(
      'control plane unreachable',
    );
  });

  it('swallows refresh failures, reports them, and serves the stale snapshot', async () => {
    let calls = 0;
    const flaky: FlagProvider = {
      name: 'flaky',
      load: () => {
        calls += 1;
        return calls === 1
          ? Promise.resolve(createSnapshot(flags))
          : Promise.reject(new Error('boom'));
      },
    };

    const onError = vi.fn();
    const client = new FeatureFlagClient({ provider: flaky, onError });
    await client.init();

    expect(await client.refresh()).toBe(false);
    expect(client.getBoolean('new-checkout', false)).toBe(true);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[1]).toEqual({ operation: 'load', provider: 'flaky' });
  });

  it('closes the provider and reports close failures without throwing', async () => {
    const close = vi.fn(() => Promise.reject(new Error('close failed')));
    const onError = vi.fn();

    const client = new FeatureFlagClient({
      provider: { name: 'closable', load: () => Promise.resolve(createSnapshot([])), close },
      onError,
    });

    await expect(client.close()).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[1]).toMatchObject({ operation: 'close' });
  });

  it('accepts a pushed snapshot', () => {
    const client = new FeatureFlagClient({ provider: new StaticProvider() });
    client.setSnapshot(createSnapshot(flags, { version: 'rev-9' }));

    expect(client.ready).toBe(true);
    expect(client.snapshot.version).toBe('rev-9');
    expect(client.getBoolean('new-checkout', false)).toBe(true);
  });
});
