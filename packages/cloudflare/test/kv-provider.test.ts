import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_FLAGS_KEY, KvFlagProvider, WorkerFlags } from '../src/index.js';
import type { KvFlagMetadata } from '../src/index.js';

const ruleset = [
  {
    key: 'new-checkout',
    enabled: true,
    variants: { on: true, off: false },
    defaultVariant: 'on',
    offVariant: 'off',
  },
];

/** Minimal stand-in for the slice of KVNamespace the provider uses. */
function fakeKv(value: unknown, metadata?: KvFlagMetadata) {
  const getWithMetadata = vi.fn(() => Promise.resolve({ value, metadata: metadata ?? null }));
  return { namespace: { getWithMetadata } as unknown as KVNamespace, getWithMetadata };
}

describe('KvFlagProvider', () => {
  it('loads and parses the ruleset from the default key', async () => {
    const { namespace, getWithMetadata } = fakeKv(ruleset);
    const snapshot = await new KvFlagProvider({ namespace }).load();

    expect(getWithMetadata).toHaveBeenCalledWith(DEFAULT_FLAGS_KEY, { type: 'json' });
    expect(snapshot?.flags.get('new-checkout')?.enabled).toBe(true);
  });

  it('passes a cache TTL through to KV when configured', async () => {
    const { namespace, getWithMetadata } = fakeKv(ruleset);
    await new KvFlagProvider({ namespace, key: 'flags:v2', cacheTtlSeconds: 300 }).load();

    expect(getWithMetadata).toHaveBeenCalledWith('flags:v2', { type: 'json', cacheTtl: 300 });
  });

  it('carries the KV revision onto the snapshot', async () => {
    const { namespace } = fakeKv(ruleset, { revision: 'rev-7' });
    const snapshot = await new KvFlagProvider({ namespace }).load();

    expect(snapshot?.version).toBe('rev-7');
  });

  it('skips re-parsing when the revision is unchanged', async () => {
    const { namespace } = fakeKv(ruleset, { revision: 'rev-7' });
    const provider = new KvFlagProvider({ namespace });

    const first = await provider.load();
    expect(await provider.load(first ?? undefined)).toBeNull();
  });

  it('reloads when the revision moves', async () => {
    const { namespace } = fakeKv(ruleset, { revision: 'rev-7' });
    const provider = new KvFlagProvider({ namespace });
    const stale = await provider.load();

    const bumped = new KvFlagProvider(fakeKv(ruleset, { revision: 'rev-8' }));
    expect(await bumped.load(stale ?? undefined)).not.toBeNull();
  });

  it('throws when the key is absent, so a cold start fails loudly', async () => {
    const { namespace } = fakeKv(null);
    await expect(new KvFlagProvider({ namespace }).load()).rejects.toThrow(/No flag ruleset/u);
  });

  it('reports parse issues but still loads the valid flags', async () => {
    const onParseIssues = vi.fn();
    const { namespace } = fakeKv([...ruleset, { key: 'broken', enabled: 'nope' }]);

    const snapshot = await new KvFlagProvider({ namespace, onParseIssues }).load();

    expect(snapshot?.flags.size).toBe(1);
    expect(onParseIssues).toHaveBeenCalledOnce();
  });
});

describe('WorkerFlags', () => {
  it('loads once on a cold isolate and shares that load across concurrent requests', async () => {
    const { namespace, getWithMetadata } = fakeKv(ruleset, { revision: 'rev-1' });
    const flags = new WorkerFlags({ provider: new KvFlagProvider({ namespace }) });

    const [a, b] = await Promise.all([flags.get(), flags.get()]);

    expect(getWithMetadata).toHaveBeenCalledOnce();
    expect(a).toBe(b);
    expect(a.getBoolean('new-checkout', false)).toBe(true);
  });

  it('does not hit KV again while the snapshot is fresh', async () => {
    const { namespace, getWithMetadata } = fakeKv(ruleset, { revision: 'rev-1' });
    const flags = new WorkerFlags({
      provider: new KvFlagProvider({ namespace }),
      refreshIntervalMs: 60_000,
    });

    await flags.get();
    await flags.get();

    expect(getWithMetadata).toHaveBeenCalledOnce();
  });

  it('hands a stale refresh to waitUntil instead of blocking the request', async () => {
    const { namespace, getWithMetadata } = fakeKv(ruleset, { revision: 'rev-1' });
    const scheduled: Promise<unknown>[] = [];
    const flags = new WorkerFlags({
      provider: new KvFlagProvider({ namespace }),
      refreshIntervalMs: 0,
    });

    await flags.get();
    await flags.get({
      waitUntil: (promise) => {
        scheduled.push(promise);
      },
    });

    expect(scheduled).toHaveLength(1);
    await Promise.all(scheduled);
    expect(getWithMetadata).toHaveBeenCalledTimes(2);
  });

  it('retries the initial load on the next request after a failure', async () => {
    let attempt = 0;
    const namespace = {
      getWithMetadata: vi.fn(() => {
        attempt += 1;
        return attempt === 1
          ? Promise.reject(new Error('KV unavailable'))
          : Promise.resolve({ value: ruleset, metadata: null });
      }),
    } as unknown as KVNamespace;

    const onError = vi.fn();
    const flags = new WorkerFlags({ provider: new KvFlagProvider({ namespace }), onError });

    await expect(flags.get()).rejects.toThrow('KV unavailable');
    expect(onError).toHaveBeenCalledOnce();

    const client = await flags.get();
    expect(client.getBoolean('new-checkout', false)).toBe(true);
  });

  it('exposes the client synchronously for call sites that cannot await', () => {
    const { namespace } = fakeKv(ruleset);
    const flags = new WorkerFlags({ provider: new KvFlagProvider({ namespace }) });

    expect(flags.client.ready).toBe(false);
    expect(flags.client.getBoolean('new-checkout', false)).toBe(false);
  });
});
