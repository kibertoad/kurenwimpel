import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_FLAGS_KEY, KvFlagProvider, revisionKey, WorkerFlags } from '../src/index.js';
import type { FlagDefinition, KvFlagMetadata, KvRevisionMetadata } from '../src/index.js';

// Replays, against the local KV binding, the writes `kurenwimpel publish` and
// `kurenwimpel rollback` make through the Cloudflare REST API.

function edition(enabled: boolean): FlagDefinition[] {
  return [
    {
      key: 'new-checkout',
      enabled,
      variants: { on: true, off: false },
      defaultVariant: 'on',
      offVariant: 'off',
    },
  ];
}

async function publish(revision: string, flags: FlagDefinition[]): Promise<void> {
  const payload = JSON.stringify(flags);
  const stored: KvRevisionMetadata = { revision, publishedAt: new Date().toISOString() };
  await env.FLAGS.put(revisionKey(revision), payload, { metadata: stored });
  const current: KvFlagMetadata = { revision };
  await env.FLAGS.put(DEFAULT_FLAGS_KEY, payload, { metadata: current });
}

async function rollback(revision: string): Promise<void> {
  const payload = await env.FLAGS.get(revisionKey(revision));
  if (payload === null) throw new Error(`revision ${revision} is not stored`);
  const current: KvFlagMetadata = { revision };
  await env.FLAGS.put(DEFAULT_FLAGS_KEY, payload, { metadata: current });
}

beforeEach(async () => {
  const { keys } = await env.FLAGS.list();
  await Promise.all(keys.map((entry) => env.FLAGS.delete(entry.name)));
});

describe('the kurenwimpel publish layout', () => {
  it('is picked up by a running WorkerFlags on its next refresh, rollback included', async () => {
    const flags = new WorkerFlags({
      provider: new KvFlagProvider({ namespace: env.FLAGS }),
      refreshIntervalMs: 0,
    });

    await publish('rev-a', edition(true));
    const client = await flags.get();
    expect(client.getBoolean('new-checkout', false)).toBe(true);

    await publish('rev-b', edition(false));
    await flags.get();
    expect(client.getBoolean('new-checkout', true)).toBe(false);

    await rollback('rev-a');
    await flags.get();
    expect(client.getBoolean('new-checkout', false)).toBe(true);

    const { keys } = await env.FLAGS.list({ prefix: revisionKey('') });
    expect(keys.map((key) => key.name).toSorted()).toEqual(['flags:rev:rev-a', 'flags:rev:rev-b']);
  });
});
