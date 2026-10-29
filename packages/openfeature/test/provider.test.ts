import { FeatureFlagClient, StaticProvider } from '@kurenwimpel/core';
import type { FlagDefinition, FlagProvider, FlagSnapshot } from '@kurenwimpel/core';
import {
  ErrorCode,
  OpenFeature,
  ProviderStatus,
  StandardResolutionReasons,
} from '@openfeature/server-sdk';
import type { EvaluationDetails, FlagValue, Hook } from '@openfeature/server-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { KurenwimpelProvider } from '../src/index.js';

const checkout: FlagDefinition = {
  key: 'new-checkout',
  enabled: true,
  variants: { on: true, off: false },
  defaultVariant: 'off',
  offVariant: 'off',
  rules: [
    {
      id: 'early-adopters',
      conditions: [{ attribute: 'signedUpAt', operator: 'lt', value: 1_600_000_000_000 }],
      variant: 'on',
    },
  ],
  metadata: { owner: 'payments' },
};

const flags: FlagDefinition[] = [
  checkout,
  {
    key: 'banner',
    enabled: true,
    variants: { a: 'hello' },
    defaultVariant: 'a',
    offVariant: 'a',
  },
  { key: 'limit', enabled: true, variants: { a: 42 }, defaultVariant: 'a', offVariant: 'a' },
  {
    key: 'theme',
    enabled: true,
    variants: { a: { color: 'blue' } },
    defaultVariant: 'a',
    offVariant: 'a',
  },
];

type Answer = FlagSnapshot | null | Error;

function scripted(...answers: Answer[]): FlagProvider {
  return {
    name: 'scripted',
    load: () => {
      const next = answers.shift();
      if (next === undefined) throw new Error('no answer queued');
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
  };
}

let domain = 0;

async function connect(client: FeatureFlagClient) {
  const name = `test-${String((domain += 1))}`;
  await OpenFeature.setProviderAndWait(name, new KurenwimpelProvider(client));
  return OpenFeature.getClient(name);
}

afterEach(async () => {
  await OpenFeature.close();
});

describe('KurenwimpelProvider', () => {
  it('loads a client that is not ready yet', async () => {
    const client = new FeatureFlagClient({ provider: new StaticProvider(flags) });

    const features = await connect(client);

    expect(client.ready).toBe(true);
    expect(features.providerStatus).toBe(ProviderStatus.READY);
    expect(features.metadata.providerMetadata.name).toBe('kurenwimpel');
  });

  it('does not reload a client that is already ready', async () => {
    const client = new FeatureFlagClient({ provider: new StaticProvider(flags) });
    await client.init();
    const init = vi.spyOn(client, 'init');

    await connect(client);

    expect(init).not.toHaveBeenCalled();
  });

  it('fails to start when the first load fails', async () => {
    const client = new FeatureFlagClient({ provider: scripted(new Error('down')) });

    await expect(
      OpenFeature.setProviderAndWait('failing', new KurenwimpelProvider(client)),
    ).rejects.toThrow('down');
    expect(OpenFeature.getClient('failing').providerStatus).toBe(ProviderStatus.ERROR);
  });

  it('closes the client', async () => {
    const client = new FeatureFlagClient({ provider: new StaticProvider(flags) });
    const close = vi.spyOn(client, 'close');
    await connect(client);

    await OpenFeature.close();

    expect(close).toHaveBeenCalledOnce();
  });
});

describe('resolution', () => {
  it('resolves every value type with variant, reason and metadata', async () => {
    const features = await connect(new FeatureFlagClient({ provider: new StaticProvider(flags) }));

    expect(await features.getBooleanDetails('new-checkout', true)).toMatchObject({
      value: false,
      variant: 'off',
      reason: StandardResolutionReasons.STATIC,
      flagMetadata: { owner: 'payments' },
    });
    expect(await features.getStringValue('banner', 'x')).toBe('hello');
    expect(await features.getNumberValue('limit', 0)).toBe(42);
    expect(await features.getObjectValue('theme', {})).toEqual({ color: 'blue' });
  });

  it('matches numeric conditions against a Date in the context', async () => {
    const features = await connect(new FeatureFlagClient({ provider: new StaticProvider(flags) }));

    const details = await features.getBooleanDetails('new-checkout', false, {
      signedUpAt: new Date(1_500_000_000_000),
    });

    expect(details).toMatchObject({
      value: true,
      reason: StandardResolutionReasons.TARGETING_MATCH,
    });
  });

  it('serves the default with an error code for an unknown flag', async () => {
    const features = await connect(new FeatureFlagClient({ provider: new StaticProvider(flags) }));

    expect(await features.getStringDetails('missing', 'fallback')).toMatchObject({
      value: 'fallback',
      reason: StandardResolutionReasons.ERROR,
      errorCode: ErrorCode.FLAG_NOT_FOUND,
    });
  });

  it('reports a type mismatch', async () => {
    const features = await connect(new FeatureFlagClient({ provider: new StaticProvider(flags) }));

    expect(await features.getNumberDetails('banner', 7)).toMatchObject({
      value: 7,
      errorCode: ErrorCode.TYPE_MISMATCH,
    });
  });

  it('serves a non-object default when the object flag is missing', async () => {
    const features = await connect(new FeatureFlagClient({ provider: new StaticProvider(flags) }));

    expect(await features.getObjectValue('missing', ['a'])).toEqual(['a']);
    expect(await features.getObjectValue('banner', null)).toBeNull();
  });

  it('feeds after hooks with the resolved details', async () => {
    const features = await connect(new FeatureFlagClient({ provider: new StaticProvider(flags) }));
    const seen: EvaluationDetails<FlagValue>[] = [];
    const hook: Hook = { after: (_context, details) => void seen.push(details) };

    await features.getBooleanValue('new-checkout', false, {}, { hooks: [hook] });

    expect(seen).toMatchObject([{ flagKey: 'new-checkout', variant: 'off' }]);
  });
});
