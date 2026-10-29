import { describe, expect, it, vi } from 'vitest';

import { CountingMetrics, FeatureFlagClient, StaticProvider } from '../../src/index.js';
import type { ClientErrorInfo, FlagDefinition, MetricsSink } from '../../src/index.js';

const flags: FlagDefinition[] = [
  {
    key: 'new-checkout',
    enabled: true,
    variants: { on: true, off: false },
    defaultVariant: 'on',
    offVariant: 'off',
  },
  {
    key: 'banner',
    enabled: false,
    variants: { on: 'hello', off: '' },
    defaultVariant: 'on',
    offVariant: 'off',
  },
];

async function clientWith(
  metrics: MetricsSink,
  onError?: (error: Error, info: ClientErrorInfo) => void,
) {
  const client = new FeatureFlagClient({
    provider: new StaticProvider(flags),
    metrics,
    ...(onError === undefined ? {} : { onError }),
  });
  await client.init();
  return client;
}

describe('CountingMetrics', () => {
  it('counts per flag, variant, reason and error code', () => {
    const metrics = new CountingMetrics();
    metrics.record('a', 'on', 'STATIC');
    metrics.record('a', 'on', 'STATIC');
    metrics.record('a', 'off', 'DISABLED');
    metrics.record('b', undefined, 'ERROR', 'FLAG_NOT_FOUND');

    expect(metrics.collect()).toEqual([
      { flagKey: 'a', variant: 'on', reason: 'STATIC', errorCode: undefined, count: 2 },
      { flagKey: 'a', variant: 'off', reason: 'DISABLED', errorCode: undefined, count: 1 },
      { flagKey: 'b', variant: undefined, reason: 'ERROR', errorCode: 'FLAG_NOT_FOUND', count: 1 },
    ]);
  });

  it('resets on collect', () => {
    const metrics = new CountingMetrics();
    metrics.record('a', 'on', 'STATIC');
    metrics.collect();

    expect(metrics.collect()).toEqual([]);
  });
});

describe('client metrics', () => {
  it('records typed getters, raw evaluations, misses and type mismatches', async () => {
    const metrics = new CountingMetrics();
    const client = await clientWith(metrics);

    client.getBoolean('new-checkout', false);
    client.evaluate('banner');
    client.getString('missing', 'fallback');
    client.getString('new-checkout', 'fallback');

    expect(metrics.collect()).toEqual([
      { flagKey: 'new-checkout', variant: 'on', reason: 'STATIC', errorCode: undefined, count: 1 },
      {
        flagKey: 'new-checkout',
        variant: 'on',
        reason: 'ERROR',
        errorCode: 'TYPE_MISMATCH',
        count: 1,
      },
      { flagKey: 'banner', variant: 'off', reason: 'DISABLED', errorCode: undefined, count: 1 },
      {
        flagKey: 'missing',
        variant: undefined,
        reason: 'ERROR',
        errorCode: 'FLAG_NOT_FOUND',
        count: 1,
      },
    ]);
  });

  it('records every flag of evaluateAll', async () => {
    const metrics = new CountingMetrics();
    const client = await clientWith(metrics);

    client.evaluateAll();

    expect(metrics.collect().map((row) => row.flagKey)).toEqual(['new-checkout', 'banner']);
  });

  it('records PROVIDER_NOT_READY before the first load', () => {
    const metrics = new CountingMetrics();
    const client = new FeatureFlagClient({ provider: new StaticProvider(flags), metrics });

    client.getBoolean('new-checkout', false);

    expect(metrics.collect()).toEqual([
      {
        flagKey: 'new-checkout',
        variant: undefined,
        reason: 'ERROR',
        errorCode: 'PROVIDER_NOT_READY',
        count: 1,
      },
    ]);
  });

  it('reports a throwing sink and still answers', async () => {
    const onError = vi.fn<(error: Error, info: ClientErrorInfo) => void>();
    const broken: MetricsSink = {
      record: () => {
        throw new Error('sink broke');
      },
    };
    const client = await clientWith(broken, onError);

    expect(client.getBoolean('new-checkout', false)).toBe(true);
    expect(onError).toHaveBeenCalledWith(new Error('sink broke'), {
      operation: 'metrics',
      provider: 'static',
    });
  });
});
