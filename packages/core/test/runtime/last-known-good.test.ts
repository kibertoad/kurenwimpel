import { describe, expect, it, vi } from 'vitest';

import {
  completeSnapshot,
  createSnapshot,
  FeatureFlagClient,
  isStoredRuleset,
  loadWithFallback,
  snapshotFromRuleset,
} from '../../src/index.js';
import type {
  ClientErrorInfo,
  FlagDefinition,
  FlagProvider,
  FlagSnapshot,
  LastKnownGoodStore,
  StoredRuleset,
} from '../../src/index.js';

const checkout = (enabled: boolean): FlagDefinition => ({
  key: 'new-checkout',
  enabled,
  variants: { on: true, off: false },
  defaultVariant: 'on',
  offVariant: 'off',
});

function memoryStore(initial: StoredRuleset | null = null): LastKnownGoodStore & {
  current: StoredRuleset | null;
} {
  const store = {
    current: initial,
    read: () => Promise.resolve(store.current),
    write: (ruleset: StoredRuleset) => {
      store.current = ruleset;
      return Promise.resolve();
    },
  };
  return store;
}

/** A provider whose live source answers with whatever `next` holds. */
function scriptedProvider(store: LastKnownGoodStore) {
  const script = { next: (): unknown => Promise.reject(new Error('control plane down')) };
  const provider: FlagProvider = {
    name: 'scripted',
    load: (previous, context) => {
      const source = { lastKnownGood: store, context };
      return loadWithFallback(
        previous,
        async () => {
          const answer = await script.next();
          return answer === 'unchanged' ? null : snapshotFromRuleset(answer, {}, source);
        },
        source,
      );
    },
  };
  return { provider, script };
}

function clientFor(provider: FlagProvider) {
  const onError = vi.fn<(error: Error, info: ClientErrorInfo) => void>();
  return { client: new FeatureFlagClient({ provider, onError }), onError };
}

describe('booting from a last-known-good store', () => {
  it('comes up ready on the stored flags and reports the outage once', async () => {
    const store = memoryStore({ raw: [checkout(false)], version: 'rev-1', fetchedAt: 42 });
    const { client, onError } = clientFor(scriptedProvider(store).provider);

    await client.init();

    expect(client.ready).toBe(true);
    expect(client.getBoolean('new-checkout', true)).toBe(false);
    expect(client.snapshot).toMatchObject({ origin: 'fallback', version: 'rev-1', fetchedAt: 42 });
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[0].message).toBe('control plane down');
    expect(onError.mock.calls[0]?.[1]).toEqual({ operation: 'load', provider: 'scripted' });
  });

  it('replaces the fallback on the first successful refresh', async () => {
    const store = memoryStore({ raw: [checkout(false)], fetchedAt: 42 });
    const { provider, script } = scriptedProvider(store);
    const { client } = clientFor(provider);
    await client.init();

    script.next = () => Promise.resolve([checkout(true)]);

    expect(await client.refresh()).toBe(true);
    expect(client.snapshot.origin).toBe('live');
    expect(client.getBoolean('new-checkout', false)).toBe(true);
  });

  it('re-marks the fallback as live when the source answers unchanged', async () => {
    const store = memoryStore({ raw: [checkout(false)], version: 'rev-1', fetchedAt: 42 });
    const { provider, script } = scriptedProvider(store);
    const { client } = clientFor(provider);
    await client.init();

    script.next = () => Promise.resolve('unchanged');

    expect(await client.refresh()).toBe(true);
    expect(client.snapshot.origin).toBe('live');
    expect(client.snapshot.version).toBe('rev-1');
    expect(client.snapshot.fetchedAt).toBeGreaterThan(42);
    expect(client.getBoolean('new-checkout', true)).toBe(false);
  });

  it('keeps serving the fallback while the source stays down', async () => {
    const store = memoryStore({ raw: [checkout(false)], fetchedAt: 42 });
    const { client, onError } = clientFor(scriptedProvider(store).provider);
    await client.init();

    expect(await client.refresh()).toBe(false);
    expect(client.snapshot.origin).toBe('fallback');
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['an empty store', null],
    ['a malformed envelope', { raw: [checkout(false)] }],
    ['a payload that is not a ruleset', { raw: 'garbage', fetchedAt: 42 }],
  ])('rejects init with the original error given %s', async (_label, stored) => {
    const store = memoryStore(stored as StoredRuleset | null);
    const { client, onError } = clientFor(scriptedProvider(store).provider);

    await expect(client.init()).rejects.toThrow('control plane down');
    expect(client.ready).toBe(false);
    expect(onError).not.toHaveBeenCalled();
  });

  it('rejects init with the original error when the store cannot be read', async () => {
    const store: LastKnownGoodStore = {
      read: () => Promise.reject(new Error('disk gone')),
      write: () => Promise.resolve(),
    };
    const { client } = clientFor(scriptedProvider(store).provider);

    await expect(client.init()).rejects.toThrow('control plane down');
  });

  it('accepts a stored ruleset that was legitimately empty', async () => {
    const store = memoryStore({ raw: [], fetchedAt: 42 });
    const { client } = clientFor(scriptedProvider(store).provider);

    await client.init();

    expect(client.snapshot.origin).toBe('fallback');
  });

  it('does not fall back once a snapshot is installed', async () => {
    const store = memoryStore({ raw: [checkout(false)], fetchedAt: 42 });
    const previous = createSnapshot([checkout(true)]);
    const load = loadWithFallback(previous, () => Promise.reject(new Error('down')), {
      lastKnownGood: store,
    });

    await expect(load).rejects.toThrow('down');
  });
});

describe('snapshotFromRuleset', () => {
  it('stores the raw payload of a live load with its version and fetch time', async () => {
    const store = memoryStore();
    const raw = { flags: [checkout(true)] };

    const snapshot = snapshotFromRuleset(
      raw,
      { version: 'rev-2', fetchedAt: 7 },
      {
        lastKnownGood: store,
      },
    );
    await vi.waitFor(() => {
      expect(store.current).toEqual({ raw, version: 'rev-2', fetchedAt: 7 });
    });
    expect(snapshot.origin).toBe('live');
  });

  it('never writes a fallback snapshot back', async () => {
    const write = vi.fn(() => Promise.resolve());
    snapshotFromRuleset(
      [checkout(true)],
      { origin: 'fallback' },
      {
        lastKnownGood: { read: () => Promise.resolve(null), write },
      },
    );
    await Promise.resolve();

    expect(write).not.toHaveBeenCalled();
  });

  it('reports a failed write as a store error without failing the load', async () => {
    const reportError = vi.fn();
    const failingStore: LastKnownGoodStore = {
      read: () => Promise.resolve(null),
      write: () => {
        throw new Error('read-only filesystem');
      },
    };

    const snapshot = snapshotFromRuleset(
      [checkout(true)],
      {},
      {
        lastKnownGood: failingStore,
        context: { reportError },
      },
    );

    expect(snapshot.flags.size).toBe(1);
    await vi.waitFor(() => {
      expect(reportError).toHaveBeenCalledWith(expect.any(Error), 'store');
    });
  });
});

describe('snapshot origin', () => {
  it('defaults to live', () => {
    expect(createSnapshot([]).origin).toBe('live');
  });

  it('is completed on a snapshot built without one', () => {
    const literal = { ...createSnapshot([]), origin: undefined } as unknown as FlagSnapshot;
    expect(completeSnapshot(literal).origin).toBe('live');
  });

  it('is recognised by the stored-ruleset guard only with a numeric fetch time', () => {
    expect(isStoredRuleset({ raw: [], fetchedAt: 1, version: 'v' })).toBe(true);
    expect(isStoredRuleset({ raw: [], fetchedAt: '1' })).toBe(false);
    expect(isStoredRuleset({ raw: [], fetchedAt: 1, version: 3 })).toBe(false);
    expect(isStoredRuleset({ fetchedAt: 1 })).toBe(false);
    expect(isStoredRuleset(null)).toBe(false);
  });
});
