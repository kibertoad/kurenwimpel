import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createSnapshot,
  FeatureFlagClient,
  loadWithFallback,
  snapshotFromRuleset,
} from '../../src/index.js';
import type {
  ClientErrorInfo,
  FlagDefinition,
  FlagProvider,
  FlagSnapshot,
  LastKnownGoodStore,
} from '../../src/index.js';

const flag: FlagDefinition = {
  key: 'new-checkout',
  enabled: true,
  variants: { on: true, off: false },
  defaultVariant: 'on',
  offVariant: 'off',
};

type Answer = FlagSnapshot | null | Error;

/** Serves the queued answers in order; an Error is thrown. */
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

function snapshot(version: string): FlagSnapshot {
  return createSnapshot([flag], { version });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(1_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('status', () => {
  it('reports nothing loaded before init', () => {
    const client = new FeatureFlagClient({ provider: scripted() });

    expect(client.status()).toEqual({
      ready: false,
      origin: undefined,
      snapshotVersion: undefined,
      snapshotBuiltAt: undefined,
      lastSuccessfulLoadAt: undefined,
      lastFailedLoadAt: undefined,
      consecutiveFailures: 0,
      totalLoadFailures: 0,
      lastParseIssueCount: 0,
    });
  });

  it('keeps advancing lastSuccessfulLoadAt across unchanged answers while the snapshot ages', async () => {
    const client = new FeatureFlagClient({ provider: scripted(snapshot('r1'), null, null) });
    await client.init();

    vi.setSystemTime(31_000);
    await client.refresh();
    vi.setSystemTime(61_000);
    await client.refresh();

    expect(client.status()).toMatchObject({
      ready: true,
      origin: 'live',
      snapshotVersion: 'r1',
      snapshotBuiltAt: 1_000,
      lastSuccessfulLoadAt: 61_000,
      consecutiveFailures: 0,
    });
  });

  it('counts failures and resets the streak on the next success', async () => {
    const onError = vi.fn<(error: Error, info: ClientErrorInfo) => void>();
    const client = new FeatureFlagClient({
      provider: scripted(snapshot('r1'), new Error('down'), new Error('down'), snapshot('r2')),
      onError,
    });
    await client.init();

    vi.setSystemTime(2_000);
    await client.refresh();
    vi.setSystemTime(3_000);
    await client.refresh();

    expect(client.status()).toMatchObject({
      lastSuccessfulLoadAt: 1_000,
      lastFailedLoadAt: 3_000,
      consecutiveFailures: 2,
      totalLoadFailures: 2,
    });

    vi.setSystemTime(4_000);
    await client.refresh();

    expect(client.status()).toMatchObject({
      snapshotVersion: 'r2',
      lastSuccessfulLoadAt: 4_000,
      lastFailedLoadAt: 3_000,
      consecutiveFailures: 0,
      totalLoadFailures: 2,
    });
  });

  it('counts a failed first load', async () => {
    const client = new FeatureFlagClient({ provider: scripted(new Error('down')) });

    await expect(client.init()).rejects.toThrow('down');
    expect(client.status()).toMatchObject({ ready: false, consecutiveFailures: 1 });
  });

  it('counts a boot from a last-known-good copy as a failure', async () => {
    const store: LastKnownGoodStore = {
      read: () => Promise.resolve({ raw: { flags: [flag] }, fetchedAt: 500 }),
      write: () => Promise.resolve(),
    };
    const provider: FlagProvider = {
      name: 'falling-back',
      load: (previous, context) =>
        loadWithFallback(previous, () => Promise.reject(new Error('down')), {
          lastKnownGood: store,
          context,
        }),
    };
    const client = new FeatureFlagClient({ provider, onError: () => {} });
    await client.init();

    expect(client.status()).toMatchObject({
      ready: true,
      origin: 'fallback',
      snapshotBuiltAt: 500,
      lastSuccessfulLoadAt: undefined,
      lastFailedLoadAt: 1_000,
      consecutiveFailures: 1,
    });
  });

  it('reports the parse issue count of the served snapshot', async () => {
    const payloads: unknown[] = [{ flags: [flag, { key: 'broken' }] }, { flags: [flag] }];
    const provider: FlagProvider = {
      name: 'parsing',
      load: (_previous, context) =>
        Promise.resolve(snapshotFromRuleset(payloads.shift(), {}, { context })),
    };
    const client = new FeatureFlagClient({ provider });
    await client.init();

    expect(client.status().lastParseIssueCount).toBe(1);

    await client.refresh();

    expect(client.status().lastParseIssueCount).toBe(0);
  });

  it('treats a live setSnapshot as a successful load', () => {
    const client = new FeatureFlagClient({ provider: scripted() });
    client.setSnapshot(snapshot('pushed'));

    expect(client.status()).toMatchObject({ ready: true, lastSuccessfulLoadAt: 1_000 });
  });
});

describe('onSnapshotChange', () => {
  it('fires on install with the previous snapshot, and not on unchanged answers', async () => {
    const changes: [string | undefined, string | undefined][] = [];
    const client = new FeatureFlagClient({
      provider: scripted(snapshot('r1'), null, snapshot('r2')),
      onSnapshotChange: (current, previous) => {
        changes.push([current.version, previous?.version]);
      },
    });

    await client.init();
    await client.refresh();
    await client.refresh();

    expect(changes).toEqual([
      ['r1', undefined],
      ['r2', 'r1'],
    ]);
  });

  it('reports a throwing hook and still installs the snapshot', async () => {
    const onError = vi.fn<(error: Error, info: ClientErrorInfo) => void>();
    const client = new FeatureFlagClient({
      provider: scripted(snapshot('r1')),
      onError,
      onSnapshotChange: () => {
        throw new Error('listener broke');
      },
    });

    await client.init();

    expect(client.snapshot.version).toBe('r1');
    expect(onError).toHaveBeenCalledWith(new Error('listener broke'), {
      operation: 'snapshotChange',
      provider: 'scripted',
    });
  });
});
