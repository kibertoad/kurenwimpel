import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_FLAGS_KEY, KvFlagProvider } from '../src/index.js';
import type { FlagDefinition, LastKnownGoodStore, StoredRuleset } from '../src/index.js';

const checkout = (enabled: boolean): FlagDefinition => ({
  key: 'new-checkout',
  enabled,
  variants: { on: true, off: false },
  defaultVariant: 'on',
  offVariant: 'off',
});

function memoryStore(initial: StoredRuleset | null): LastKnownGoodStore {
  let current = initial;
  return {
    read: () => Promise.resolve(current),
    write: (ruleset) => {
      current = ruleset;
      return Promise.resolve();
    },
  };
}

beforeEach(async () => {
  const { keys } = await env.FLAGS.list();
  await Promise.all(keys.map((entry) => env.FLAGS.delete(entry.name)));
});

describe('KvFlagProvider with a last-known-good store', () => {
  const stored: StoredRuleset = { raw: [checkout(false)], version: 'rev-1', fetchedAt: 42 };

  it('serves the stored ruleset when the key is missing on the first load', async () => {
    const provider = new KvFlagProvider({
      namespace: env.FLAGS,
      lastKnownGood: memoryStore(stored),
    });

    const snapshot = await provider.load();

    expect(snapshot?.origin).toBe('fallback');
    expect(snapshot?.flags.get('new-checkout')?.enabled).toBe(false);
  });

  it('re-marks the fallback as live once KV holds the same revision', async () => {
    const provider = new KvFlagProvider({
      namespace: env.FLAGS,
      lastKnownGood: memoryStore(stored),
    });
    const fallback = await provider.load();

    await env.FLAGS.put(DEFAULT_FLAGS_KEY, JSON.stringify(stored.raw), {
      metadata: { revision: 'rev-1' },
    });
    const confirmed = await provider.load(fallback ?? undefined);

    expect(confirmed?.origin).toBe('live');
    expect(confirmed?.version).toBe('rev-1');
  });
});
