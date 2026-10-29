import { describe, expect, it, vi } from 'vitest';

import { createSnapshot, FeatureFlagClient } from '../../src/index.js';
import type {
  ClientErrorInfo,
  FlagDefinition,
  FlagProvider,
  FlagSnapshot,
  LoadResult,
} from '../../src/index.js';

const flag: FlagDefinition = {
  key: 'new-checkout',
  enabled: true,
  variants: { on: true, off: false },
  defaultVariant: 'on',
  offVariant: 'off',
};

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

function snapshot(version: string): FlagSnapshot {
  return createSnapshot([flag], { version });
}

describe('subscribe', () => {
  it('reports every load outcome and every installed snapshot', async () => {
    const client = new FeatureFlagClient({
      provider: scripted(snapshot('r1'), null, new Error('down'), snapshot('r2')),
    });
    const loads: LoadResult[] = [];
    const changes: [string | undefined, string | undefined][] = [];
    client.subscribe({
      onLoad: (result) => loads.push(result),
      onSnapshotChange: (next, previous) => changes.push([next.version, previous?.version]),
    });

    await client.init();
    await client.refresh();
    await client.refresh();
    await client.refresh();

    expect(loads).toEqual(['installed', 'unchanged', 'failed', 'installed']);
    expect(changes).toEqual([
      ['r1', undefined],
      ['r2', 'r1'],
    ]);
  });

  it('sees status() already updated when onLoad runs', async () => {
    const client = new FeatureFlagClient({ provider: scripted(snapshot('r1'), new Error('down')) });
    const failures: number[] = [];
    client.subscribe({ onLoad: () => failures.push(client.status().consecutiveFailures) });

    await client.init();
    await client.refresh();

    expect(failures).toEqual([0, 1]);
  });

  it('reports snapshots set directly', () => {
    const client = new FeatureFlagClient({ provider: scripted() });
    const onSnapshotChange = vi.fn();
    client.subscribe({ onSnapshotChange });

    client.setSnapshot(snapshot('pushed'));

    expect(onSnapshotChange).toHaveBeenCalledOnce();
  });

  it('stops notifying once unsubscribed', async () => {
    const client = new FeatureFlagClient({ provider: scripted(snapshot('r1'), snapshot('r2')) });
    const onLoad = vi.fn();
    const unsubscribe = client.subscribe({ onLoad });

    await client.init();
    unsubscribe();
    await client.refresh();

    expect(onLoad).toHaveBeenCalledOnce();
  });

  it('reports a throwing listener and still notifies the others', async () => {
    const onError = vi.fn<(error: Error, info: ClientErrorInfo) => void>();
    const client = new FeatureFlagClient({ provider: scripted(snapshot('r1')), onError });
    const onLoad = vi.fn();
    client.subscribe({
      onLoad: () => {
        throw new Error('listener broke');
      },
    });
    client.subscribe({ onLoad });

    await client.init();

    expect(onLoad).toHaveBeenCalledWith('installed');
    expect(onError).toHaveBeenCalledWith(new Error('listener broke'), {
      operation: 'listener',
      provider: 'scripted',
    });
  });
});
