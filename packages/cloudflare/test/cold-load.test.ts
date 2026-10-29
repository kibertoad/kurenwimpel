import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

import { DEFAULT_FLAGS_KEY, KvFlagProvider, WorkerFlags } from '../src/index.js';
import type { FlagDefinition, WorkerFlagsOptions } from '../src/index.js';

const checkout = (enabled: boolean): FlagDefinition => ({
  key: 'new-checkout',
  enabled,
  variants: { on: true, off: false },
  defaultVariant: 'on',
  offVariant: 'off',
});

const READ_TIMEOUT_MS = 20;

type KvSpy = MockInstance<KVNamespace['getWithMetadata']>;

const failures: Record<string, () => KvSpy> = {
  'a missing key': () => vi.spyOn(env.FLAGS, 'getWithMetadata'),
  'a throwing KV binding': () =>
    vi.spyOn(env.FLAGS, 'getWithMetadata').mockRejectedValue(new Error('KV unavailable')),
  'a read slower than timeoutMs': () =>
    vi.spyOn(env.FLAGS, 'getWithMetadata').mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(resolve, READ_TIMEOUT_MS * 10);
        }) as never,
    ),
};

function workerFlags(options: Partial<WorkerFlagsOptions> = {}): WorkerFlags {
  return new WorkerFlags({
    provider: new KvFlagProvider({ namespace: env.FLAGS, timeoutMs: READ_TIMEOUT_MS }),
    ...options,
  });
}

async function recover(spy: KvSpy, enabled: boolean): Promise<void> {
  spy.mockRestore();
  await env.FLAGS.put(DEFAULT_FLAGS_KEY, JSON.stringify([checkout(enabled)]));
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

beforeEach(async () => {
  const { keys } = await env.FLAGS.list();
  await Promise.all(keys.map((entry) => env.FLAGS.delete(entry.name)));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('KvFlagProvider timeoutMs', () => {
  it('fails a read that outlasts the timeout with an error naming the key', async () => {
    failures['a read slower than timeoutMs']?.();
    const provider = new KvFlagProvider({ namespace: env.FLAGS, timeoutMs: READ_TIMEOUT_MS });

    await expect(provider.load()).rejects.toThrow(
      `KV read of "${DEFAULT_FLAGS_KEY}" did not finish within ${READ_TIMEOUT_MS}ms`,
    );
  });
});

describe.each(Object.entries(failures))('WorkerFlags cold load with %s', (_name, fail) => {
  it('serves defaults and backs off, reporting once per attempt', async () => {
    const kv = fail();
    const onError = vi.fn();
    const flags = workerFlags({ onError, retryAfterMs: 60_000 });

    const clients = await Promise.all([flags.get(), flags.get()]);
    const later = await flags.get();

    expect(later).toBe(clients[0]);
    expect(later.getBooleanDetails('new-checkout', true)).toMatchObject({
      value: true,
      errorCode: 'PROVIDER_NOT_READY',
    });
    expect(kv).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('rejects without another KV read during the backoff under onInitFailure: throw', async () => {
    const kv = fail();
    const flags = workerFlags({ onInitFailure: 'throw', retryAfterMs: 60_000 });

    await expect(flags.get()).rejects.toThrow();
    await expect(flags.get()).rejects.toThrow();

    expect(kv).toHaveBeenCalledOnce();
  });

  it('retries after retryAfterMs and installs the first ruleset that loads', async () => {
    const kv = fail();
    const onError = vi.fn();
    const flags = workerFlags({ onError, retryAfterMs: 5 });
    await flags.get();

    await recover(kv, true);
    await wait(10);
    const client = await flags.get();

    expect(client.getBoolean('new-checkout', false)).toBe(true);
    expect(client.snapshot.origin).toBe('live');
    expect(onError).toHaveBeenCalledOnce();
  });

  it('serves the bootstrap, then replaces it with the first ruleset that loads', async () => {
    const kv = fail();
    const flags = workerFlags({ bootstrap: [checkout(false)], retryAfterMs: 5 });

    const client = await flags.get();
    expect(client.snapshot.origin).toBe('fallback');
    expect(client.getBoolean('new-checkout', true)).toBe(false);

    await recover(kv, true);
    await wait(10);
    const scheduled: Promise<unknown>[] = [];
    await flags.get({ waitUntil: (promise) => scheduled.push(promise) });
    await Promise.all(scheduled);

    expect(scheduled).toHaveLength(1);
    expect(client.snapshot.origin).toBe('live');
    expect(client.getBoolean('new-checkout', false)).toBe(true);
  });

  it('serves the bootstrap even under onInitFailure: throw', async () => {
    fail();
    const flags = workerFlags({ bootstrap: [checkout(false)], onInitFailure: 'throw' });

    const client = await flags.get();

    expect(client.getBoolean('new-checkout', true)).toBe(false);
  });
});
