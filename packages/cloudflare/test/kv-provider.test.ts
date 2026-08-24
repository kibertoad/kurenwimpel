import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_FLAGS_KEY, KvFlagProvider, WorkerFlags } from '../src/index.js';
import type { FlagDefinition } from '../src/index.js';

// These run inside workerd against the KV binding from wrangler.toml. Storage is
// isolated per test, so each one starts from an empty namespace.

const ruleset: FlagDefinition[] = [
  {
    key: 'new-checkout',
    enabled: true,
    variants: { on: true, off: false },
    defaultVariant: 'on',
    offVariant: 'off',
  },
];

async function seed(value: unknown, revision?: string, key = DEFAULT_FLAGS_KEY): Promise<void> {
  await env.FLAGS.put(
    key,
    JSON.stringify(value),
    revision === undefined ? {} : { metadata: { revision } },
  );
}

beforeEach(async () => {
  const { keys } = await env.FLAGS.list();
  await Promise.all(keys.map((entry) => env.FLAGS.delete(entry.name)));
});

afterEach(() => {
  vi.restoreAllMocks();
});

it('runs inside workerd rather than falling back to a Node environment', () => {
  // Guards the pool config: if this drops back to Node the KV binding below
  // would be a shim and the suite would stop testing what it claims to.
  expect(navigator.userAgent).toBe('Cloudflare-Workers');
});

describe('KvFlagProvider', () => {
  it('loads and parses the ruleset from the default key', async () => {
    await seed(ruleset);

    const snapshot = await new KvFlagProvider({ namespace: env.FLAGS }).load();

    expect(snapshot?.flags.get('new-checkout')?.enabled).toBe(true);
  });

  it('reads the key it was configured with', async () => {
    await seed(ruleset, undefined, 'flags:v2');

    const snapshot = await new KvFlagProvider({ namespace: env.FLAGS, key: 'flags:v2' }).load();

    expect(snapshot?.flags.size).toBe(1);
  });

  it('passes the cache TTL through to KV', async () => {
    await seed(ruleset);
    const getWithMetadata = vi.spyOn(env.FLAGS, 'getWithMetadata');

    await new KvFlagProvider({ namespace: env.FLAGS, cacheTtlSeconds: 300 }).load();

    expect(getWithMetadata).toHaveBeenCalledWith(DEFAULT_FLAGS_KEY, {
      type: 'json',
      cacheTtl: 300,
    });
  });

  it('omits the cache TTL when it is not configured', async () => {
    await seed(ruleset);
    const getWithMetadata = vi.spyOn(env.FLAGS, 'getWithMetadata');

    await new KvFlagProvider({ namespace: env.FLAGS }).load();

    expect(getWithMetadata).toHaveBeenCalledWith(DEFAULT_FLAGS_KEY, { type: 'json' });
  });

  it('carries the KV revision metadata onto the snapshot', async () => {
    await seed(ruleset, 'rev-7');

    const snapshot = await new KvFlagProvider({ namespace: env.FLAGS }).load();

    expect(snapshot?.version).toBe('rev-7');
  });

  it('skips re-parsing when the revision is unchanged', async () => {
    await seed(ruleset, 'rev-7');
    const provider = new KvFlagProvider({ namespace: env.FLAGS });

    const first = await provider.load();

    expect(await provider.load(first ?? undefined)).toBeNull();
  });

  it('reloads when the revision moves', async () => {
    await seed(ruleset, 'rev-7');
    const provider = new KvFlagProvider({ namespace: env.FLAGS });
    const stale = await provider.load();

    await seed([{ ...ruleset[0], enabled: false }], 'rev-8');

    const fresh = await provider.load(stale ?? undefined);

    expect(fresh?.version).toBe('rev-8');
    expect(fresh?.flags.get('new-checkout')?.enabled).toBe(false);
  });

  it('reloads every time when the writer stamps no revision', async () => {
    await seed(ruleset);
    const provider = new KvFlagProvider({ namespace: env.FLAGS });

    const first = await provider.load();

    expect(await provider.load(first ?? undefined)).not.toBeNull();
  });

  it('throws when the key is absent, so a cold start fails loudly', async () => {
    await expect(new KvFlagProvider({ namespace: env.FLAGS }).load()).rejects.toThrow(
      /No flag ruleset/u,
    );
  });

  it('reports parse issues but still loads the valid flags', async () => {
    await seed([...ruleset, { key: 'broken', enabled: 'nope' }]);
    const onParseIssues = vi.fn();

    const snapshot = await new KvFlagProvider({ namespace: env.FLAGS, onParseIssues }).load();

    expect(snapshot?.flags.size).toBe(1);
    expect(onParseIssues).toHaveBeenCalledOnce();
  });
});

describe('WorkerFlags', () => {
  it('loads once on a cold isolate and shares that load across concurrent requests', async () => {
    await seed(ruleset, 'rev-1');
    const getWithMetadata = vi.spyOn(env.FLAGS, 'getWithMetadata');
    const flags = new WorkerFlags({ provider: new KvFlagProvider({ namespace: env.FLAGS }) });

    const [first, second] = await Promise.all([flags.get(), flags.get()]);

    expect(getWithMetadata).toHaveBeenCalledOnce();
    expect(first).toBe(second);
    expect(first?.getBoolean('new-checkout', false)).toBe(true);
  });

  it('does not hit KV again while the snapshot is fresh', async () => {
    await seed(ruleset, 'rev-1');
    const flags = new WorkerFlags({
      provider: new KvFlagProvider({ namespace: env.FLAGS }),
      refreshIntervalMs: 60_000,
    });

    await flags.get();
    const getWithMetadata = vi.spyOn(env.FLAGS, 'getWithMetadata');
    await flags.get();

    expect(getWithMetadata).not.toHaveBeenCalled();
  });

  it('hands a stale refresh to waitUntil instead of blocking the request', async () => {
    await seed(ruleset, 'rev-1');
    const scheduled: Promise<unknown>[] = [];
    const flags = new WorkerFlags({
      provider: new KvFlagProvider({ namespace: env.FLAGS }),
      refreshIntervalMs: 0,
    });

    await flags.get();
    await seed([{ ...ruleset[0], enabled: false }], 'rev-2');

    const client = await flags.get({
      waitUntil: (promise) => {
        scheduled.push(promise);
      },
    });

    // The request saw the old snapshot; the reload was deferred, not awaited.
    expect(scheduled).toHaveLength(1);
    expect(client.getBoolean('new-checkout', false)).toBe(true);

    await Promise.all(scheduled);
    expect(client.getBoolean('new-checkout', false)).toBe(false);
  });

  it('retries the initial load on the next request after a failure', async () => {
    await seed(ruleset, 'rev-1');
    vi.spyOn(env.FLAGS, 'getWithMetadata').mockRejectedValueOnce(new Error('KV unavailable'));

    const onError = vi.fn();
    const flags = new WorkerFlags({
      provider: new KvFlagProvider({ namespace: env.FLAGS }),
      onError,
    });

    await expect(flags.get()).rejects.toThrow('KV unavailable');
    expect(onError).toHaveBeenCalledOnce();

    const client = await flags.get();
    expect(client.getBoolean('new-checkout', false)).toBe(true);
  });

  it('exposes the client synchronously for call sites that cannot await', () => {
    const flags = new WorkerFlags({ provider: new KvFlagProvider({ namespace: env.FLAGS }) });

    expect(flags.client.ready).toBe(false);
    expect(flags.client.getBoolean('new-checkout', false)).toBe(false);
  });
});
