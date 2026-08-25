/**
 * Loading, refreshing, and shutting down: the client's side of the provider
 * contract. Evaluation through the client is exercised in `client.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest';

import { createSnapshot, FeatureFlagClient, StaticProvider } from '../../src/index.js';
import type {
  ClientErrorInfo,
  FlagDefinition,
  FlagProvider,
  FlagSnapshot,
} from '../../src/index.js';

const flags: FlagDefinition[] = [
  {
    key: 'new-checkout',
    enabled: true,
    variants: { on: true, off: false },
    defaultVariant: 'on',
    offVariant: 'off',
  },
];

/** A provider that answers "unchanged" to everything, including the first ask. */
const noRuleset: FlagProvider = { name: 'empty', load: () => Promise.resolve(null) };

describe('provider lifecycle', () => {
  it('installs a new snapshot on refresh', async () => {
    const provider = new StaticProvider(flags);
    const client = new FeatureFlagClient({ provider });
    await client.init();

    provider.replace(flags.map((flag) => ({ ...flag, enabled: false })));

    expect(await client.refresh()).toBe(true);
    expect(client.getBoolean('new-checkout', true)).toBe(false);
  });

  it('coalesces overlapping refreshes so a slow load cannot roll the snapshot back', async () => {
    let resolveLoad: ((snapshot: FlagSnapshot) => void) | undefined;
    let calls = 0;
    const slow: FlagProvider = {
      name: 'slow',
      load: () => {
        calls += 1;
        return new Promise((resolve) => {
          resolveLoad = resolve;
        });
      },
    };

    const client = new FeatureFlagClient({ provider: slow });
    const first = client.refresh();
    const second = client.refresh();

    // The overlapping call joins the in-flight load instead of racing it.
    expect(calls).toBe(1);
    resolveLoad?.(createSnapshot(flags));

    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(client.getBoolean('new-checkout', false)).toBe(true);

    // A later refresh starts a fresh load.
    const third = client.refresh();
    expect(calls).toBe(2);
    resolveLoad?.(createSnapshot(flags));
    await third;
  });

  it('shares one load between init and a concurrent refresh', async () => {
    // Two loads in flight at once resolve in whatever order the network
    // decides, and the second to arrive wins. `init` used to go straight to
    // the provider, so the coalescing guarantee held only among refreshes and
    // a slow first load could install its snapshot over a newer one.
    let resolveLoad: ((snapshot: FlagSnapshot) => void) | undefined;
    let calls = 0;
    const slow: FlagProvider = {
      name: 'slow',
      load: () => {
        calls += 1;
        return new Promise((resolve) => {
          resolveLoad = resolve;
        });
      },
    };

    const client = new FeatureFlagClient({ provider: slow });
    const refreshed = client.refresh();
    const started = client.init();

    expect(calls).toBe(1);
    resolveLoad?.(createSnapshot(flags));

    await expect(started).resolves.toBeUndefined();
    expect(await refreshed).toBe(true);
    expect(client.getBoolean('new-checkout', false)).toBe(true);
  });

  it('keeps the previous snapshot when the provider reports no change', async () => {
    const unchanging: FlagProvider = {
      name: 'unchanging',
      load: (previous?: FlagSnapshot) =>
        Promise.resolve(previous === undefined ? createSnapshot(flags) : null),
    };

    const onError = vi.fn();
    const client = new FeatureFlagClient({ provider: unchanging, onError });
    await client.init();

    expect(await client.refresh()).toBe(false);
    expect(client.getBoolean('new-checkout', false)).toBe(true);
    // Nothing to report: "unchanged" against a snapshot is a healthy answer.
    expect(onError).not.toHaveBeenCalled();
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

  it('rejects from init when the provider has no ruleset to hand over', async () => {
    // A 304 to the very first request, a proxy answering from a stale
    // validator: "unchanged" against nothing is not a snapshot. Coming up ready
    // on the empty one would serve every request on caller fallbacks, silently.
    const client = new FeatureFlagClient({ provider: noRuleset });

    await expect(client.init()).rejects.toThrow(/no change on the first load/u);
    expect(client.ready).toBe(false);
  });

  it('reports the same answer when a refresh is what performs the first load', async () => {
    // `refresh` before `init` reaches exactly the case `init` refuses to start
    // on. It cannot throw at its caller, but a bare `false` reads as "nothing
    // to install" rather than "nothing has ever been installed".
    const reported: [Error, ClientErrorInfo][] = [];
    const client = new FeatureFlagClient({
      provider: noRuleset,
      onError: (error, info) => reported.push([error, info]),
    });

    expect(await client.refresh()).toBe(false);
    expect(client.ready).toBe(false);
    expect(reported).toHaveLength(1);
    expect(reported[0]?.[0].message).toMatch(/no change on the first load/u);
    expect(reported[0]?.[1]).toEqual({ operation: 'load', provider: 'empty' });
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

/** A provider that always fails, counting how often it was actually asked. */
const failing = (): { provider: FlagProvider; loads: () => number } => {
  let loads = 0;
  return {
    provider: {
      name: 'flaky',
      load: async () => {
        loads += 1;
        await Promise.resolve();
        throw new Error('control plane down');
      },
    },
    loads: () => loads,
  };
};

describe('a failed load is reported once, however many callers joined it', () => {
  it('does not fan one provider failure out to an onError call per refresh', async () => {
    // Overlapping refreshes share a single trip to the provider, so reporting
    // on the way out raised an alert per queued poll for one failed fetch —
    // and any failure counter behind the hook counted the outage several
    // times over.
    const errors: Error[] = [];
    const { provider, loads } = failing();
    const client = new FeatureFlagClient({
      provider,
      onError: (error: Error) => errors.push(error),
    });

    await Promise.all([client.refresh(), client.refresh(), client.refresh()]);

    expect(loads()).toBe(1);
    expect(errors).toHaveLength(1);
  });

  it('still reports each load that actually happened', async () => {
    const errors: Error[] = [];
    const { provider } = failing();
    const client = new FeatureFlagClient({
      provider,
      onError: (error: Error) => errors.push(error),
    });

    await client.refresh();
    await client.refresh();

    expect(errors).toHaveLength(2);
  });

  it('still rethrows at init while a joined refresh reports', async () => {
    const errors: Error[] = [];
    const { provider, loads } = failing();
    const client = new FeatureFlagClient({
      provider,
      onError: (error: Error) => errors.push(error),
    });

    const started = client.init();
    const refreshed = client.refresh();

    await expect(started).rejects.toThrow(/control plane down/u);
    await expect(refreshed).resolves.toBe(false);
    expect(loads()).toBe(1);
    expect(errors).toHaveLength(1);
  });
});
