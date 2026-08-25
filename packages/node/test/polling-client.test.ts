import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createSnapshot,
  PollingFlagClient,
  type FlagDefinition,
  type FlagProvider,
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

describe('PollingFlagClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads on start and reloads on the interval', async () => {
    let revision = 1;
    const load = vi.fn(() =>
      Promise.resolve(createSnapshot(ruleset, { version: `rev-${revision++}`, fetchedAt: 0 })),
    );

    const client = new PollingFlagClient({
      provider: { name: 'test', load } satisfies FlagProvider,
      pollIntervalMs: 1000,
    });

    await client.start();
    expect(client.getBoolean('new-checkout', false)).toBe(true);
    expect(load).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(2500);
    expect(load).toHaveBeenCalledTimes(3);

    await client.close();
  });

  it('stops polling after close', async () => {
    const load = vi.fn(() => Promise.resolve(createSnapshot([], { fetchedAt: 0 })));
    const close = vi.fn(() => Promise.resolve());

    const client = new PollingFlagClient({
      provider: { name: 'test', load, close } satisfies FlagProvider,
      pollIntervalMs: 1000,
    });

    await client.start();
    await client.close();

    await vi.advanceTimersByTimeAsync(5000);

    expect(load).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('forwards onImpression to the underlying client', async () => {
    // The README's exposure-feed example constructs the polling client with
    // onImpression; the option must actually reach evaluation.
    const onImpression = vi.fn();
    const client = new PollingFlagClient({
      provider: {
        name: 'test',
        load: () => Promise.resolve(createSnapshot(ruleset, { fetchedAt: 0 })),
      } satisfies FlagProvider,
      onImpression,
    });

    await client.start();
    client.getBoolean('new-checkout', false, { targetingKey: 'user-1' });

    expect(onImpression).toHaveBeenCalledOnce();
    expect(onImpression.mock.calls[0]?.[0]).toMatchObject({
      flagKey: 'new-checkout',
      targetingKey: 'user-1',
    });

    await client.close();
  });

  it('rejects from start when the first load fails', async () => {
    const client = new PollingFlagClient({
      provider: {
        name: 'test',
        load: () => Promise.reject(new Error('down')),
      } satisfies FlagProvider,
    });

    await expect(client.start()).rejects.toThrow('down');
  });

  it('forwards the default context to evaluation', async () => {
    const staffOnly: FlagDefinition = {
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
    };
    const client = new PollingFlagClient({
      provider: {
        name: 'test',
        load: () => Promise.resolve(createSnapshot([staffOnly], { fetchedAt: 0 })),
      } satisfies FlagProvider,
      defaultContext: { service: 'billing' },
    });

    await client.start();
    expect(client.getBoolean('staff', false)).toBe(true);
    await client.close();
  });

  it('unrefs the poll timer so it never keeps a process alive on its own', async () => {
    const unref = vi.fn();
    const timer = { unref } as unknown as NodeJS.Timeout;
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockReturnValue(timer);
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {});

    try {
      const client = new PollingFlagClient({
        provider: {
          name: 'test',
          load: () => Promise.resolve(createSnapshot(ruleset, { fetchedAt: 0 })),
        } satisfies FlagProvider,
      });

      await client.start();
      expect(unref).toHaveBeenCalledOnce();

      await client.close();
      expect(clearIntervalSpy).toHaveBeenCalledWith(timer);
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });

  it('keeps serving the stale snapshot when a poll fails', async () => {
    let calls = 0;
    const onError = vi.fn();
    const client = new PollingFlagClient({
      provider: {
        name: 'test',
        load: () => {
          calls += 1;
          return calls === 1
            ? Promise.resolve(createSnapshot(ruleset, { version: 'rev-1', fetchedAt: 0 }))
            : Promise.reject(new Error('control plane down'));
        },
      } satisfies FlagProvider,
      pollIntervalMs: 1000,
      onError,
    });

    await client.start();
    await vi.advanceTimersByTimeAsync(1500);

    expect(client.getBoolean('new-checkout', false)).toBe(true);
    expect(onError).toHaveBeenCalled();

    await client.close();
  });
});
