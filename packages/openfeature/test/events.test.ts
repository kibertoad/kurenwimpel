import { createSnapshot, FeatureFlagClient } from '@kurenwimpel/core';
import type { FlagProvider, FlagSnapshot } from '@kurenwimpel/core';
import { OpenFeature, ProviderEvents, ProviderStatus } from '@openfeature/server-sdk';
import type { EventDetails } from '@openfeature/server-sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { KurenwimpelProvider } from '../src/index.js';

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
  return createSnapshot(
    [{ key: 'f', enabled: true, variants: { a: true }, defaultVariant: 'a', offVariant: 'a' }],
    { version },
  );
}

let domain = 0;

async function connect(...answers: Answer[]) {
  const client = new FeatureFlagClient({ provider: scripted(...answers), onError: () => {} });
  const name = `events-${String((domain += 1))}`;
  await OpenFeature.setProviderAndWait(name, new KurenwimpelProvider(client));
  const features = OpenFeature.getClient(name);
  const events: string[] = [];
  const changes: EventDetails[] = [];
  features.addHandler(ProviderEvents.ConfigurationChanged, (details) => {
    events.push('changed');
    if (details !== undefined) changes.push(details);
  });
  features.addHandler(ProviderEvents.Stale, () => events.push('stale'));
  return { client, features, events, changes };
}

afterEach(async () => {
  await OpenFeature.close();
});

describe('events', () => {
  it('emits ConfigurationChanged on a new snapshot, not on an unchanged answer', async () => {
    const { client, events, changes } = await connect(snapshot('r1'), null, snapshot('r2'));

    await client.refresh();
    expect(events).toEqual([]);

    await client.refresh();
    expect(events).toEqual(['changed']);
    expect(changes[0]?.metadata).toEqual({ version: 'r2' });
  });

  it('emits ConfigurationChanged for a snapshot set directly', async () => {
    const { client, events } = await connect(snapshot('r1'));

    client.setSnapshot(snapshot('pushed'));

    expect(events).toEqual(['changed']);
  });

  it('goes Stale once on failed refreshes and Ready again on recovery', async () => {
    const { client, features, events } = await connect(
      snapshot('r1'),
      new Error('down'),
      new Error('still down'),
      null,
    );
    const ready: number[] = [];
    features.addHandler(ProviderEvents.Ready, () => ready.push(1));
    ready.length = 0;

    await client.refresh();
    await client.refresh();
    expect(events).toEqual(['stale']);
    expect(features.providerStatus).toBe(ProviderStatus.STALE);

    await client.refresh();
    expect(features.providerStatus).toBe(ProviderStatus.READY);
    expect(ready).toEqual([1]);
  });

  it('stops emitting once closed', async () => {
    const { client, events } = await connect(snapshot('r1'), snapshot('r2'));

    await OpenFeature.close();
    await client.refresh();

    expect(events).toEqual([]);
  });
});
