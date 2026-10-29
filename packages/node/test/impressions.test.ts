import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createSnapshot,
  PollingFlagClient,
  type FlagDefinition,
  type FlagProvider,
  type ImpressionEvent,
  type PollingFlagClientOptions,
} from '../src/index.js';

const ruleset: FlagDefinition[] = [
  {
    key: 'new-checkout',
    enabled: true,
    variants: { on: true, off: false },
    defaultVariant: 'on',
    offVariant: 'off',
  },
];

const provider = {
  name: 'test',
  load: () => Promise.resolve(createSnapshot(ruleset, { fetchedAt: 0 })),
} satisfies FlagProvider;

function clientWith(options: Partial<PollingFlagClientOptions> = {}) {
  const flush = vi.fn((_events: ImpressionEvent[]) => Promise.resolve());
  const client = new PollingFlagClient({
    provider,
    pollIntervalMs: 60_000,
    impressions: { flush, flushIntervalMs: 1000 },
    ...options,
  });
  return { client, flush };
}

describe('PollingFlagClient impressions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('flushes deduplicated impressions on the interval', async () => {
    const { client, flush } = clientWith();
    await client.start();

    for (let index = 0; index < 3; index += 1) {
      client.getBoolean('new-checkout', false, { targetingKey: 'user-1' });
    }
    expect(flush).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);

    expect(flush).toHaveBeenCalledOnce();
    expect(flush.mock.calls[0]?.[0]).toHaveLength(1);
    expect(client.impressionStats()).toMatchObject({ flushed: 1, deduplicated: 2 });

    await client.close();
  });

  it('flushes what is queued on close, without waiting for the interval', async () => {
    const { client, flush } = clientWith();
    await client.start();

    client.getBoolean('new-checkout', false, { targetingKey: 'user-1' });
    client.getBoolean('new-checkout', false, { targetingKey: 'user-2' });
    await client.close();

    expect(flush).toHaveBeenCalledOnce();
    expect(flush.mock.calls[0]?.[0].map((event) => event.targetingKey)).toEqual([
      'user-1',
      'user-2',
    ]);

    await vi.advanceTimersByTimeAsync(5000);
    expect(flush).toHaveBeenCalledOnce();
  });

  it('keeps calling onImpression for every evaluation', async () => {
    const onImpression = vi.fn();
    const { client } = clientWith({ onImpression });
    await client.start();

    client.getBoolean('new-checkout', false, { targetingKey: 'user-1' });
    client.getBoolean('new-checkout', false, { targetingKey: 'user-1' });

    expect(onImpression).toHaveBeenCalledTimes(2);
    expect(client.impressionStats()).toMatchObject({ queued: 1, deduplicated: 1 });

    await client.close();
  });

  it('reports a failed batch through the client onError when impressions has none', async () => {
    const onError = vi.fn();
    const client = new PollingFlagClient({
      provider,
      onError,
      impressions: { flush: () => Promise.reject(new Error('sink down')) },
    });
    await client.start();

    client.getBoolean('new-checkout', false, { targetingKey: 'user-1' });
    await client.close();

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'sink down' }), {
      operation: 'impressionFlush',
      provider: 'test',
    });
    expect(client.impressionStats()).toMatchObject({ failed: 1 });
  });

  it('reports no stats without the impressions option', async () => {
    const client = new PollingFlagClient({ provider });
    await client.start();

    expect(client.impressionStats()).toBeUndefined();
    await expect(client.flushImpressions()).resolves.toBeUndefined();

    await client.close();
  });
});
