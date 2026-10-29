import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createSnapshot,
  DEFAULT_FLAGS_KEY,
  DEFAULT_KV_MAX_BYTES,
  KvFlagProvider,
} from '../src/index.js';
import type { FlagDefinition } from '../src/index.js';

const ruleset: FlagDefinition[] = [
  {
    key: 'new-checkout',
    enabled: true,
    variants: { on: true, off: false },
    defaultVariant: 'on',
    offVariant: 'off',
  },
];

const body = JSON.stringify(ruleset);
const bodyBytes = new TextEncoder().encode(body).byteLength;

beforeEach(async () => {
  const { keys } = await env.FLAGS.list();
  await Promise.all(keys.map((entry) => env.FLAGS.delete(entry.name)));
});

afterEach(() => {
  vi.restoreAllMocks();
});

const provider = (maxBytes: number): KvFlagProvider =>
  new KvFlagProvider({ namespace: env.FLAGS, maxBytes });

describe('KvFlagProvider maxBytes', () => {
  it('defaults to 10 MiB, under the 25 MiB KV value limit', () => {
    expect(DEFAULT_KV_MAX_BYTES).toBe(10 * 1024 * 1024);
  });

  it('accepts a value of exactly maxBytes', async () => {
    await env.FLAGS.put(DEFAULT_FLAGS_KEY, body);

    const snapshot = await provider(bodyBytes).load();

    expect(snapshot?.flags.size).toBe(1);
  });

  it('rejects a larger value without parsing it', async () => {
    await env.FLAGS.put(DEFAULT_FLAGS_KEY, body);
    const parse = vi.spyOn(JSON, 'parse');

    await expect(provider(bodyBytes - 1).load()).rejects.toThrow(/maxBytes/u);
    expect(parse).not.toHaveBeenCalled();
  });

  it('counts bytes rather than characters', async () => {
    const wide = JSON.stringify([{ ...ruleset[0], metadata: { owner: 'ü'.repeat(20) } }]);
    await env.FLAGS.put(DEFAULT_FLAGS_KEY, wide);

    await expect(provider(wide.length).load()).rejects.toThrow(/maxBytes/u);
  });

  it('does not read the value when its revision is already loaded', async () => {
    await env.FLAGS.put(DEFAULT_FLAGS_KEY, body, { metadata: { revision: 'r1' } });

    const unchanged = await provider(1).load(createSnapshot([], { version: 'r1' }));

    expect(unchanged).toBeNull();
  });

  it.each([0, -1, 1.5, Number.NaN])('refuses maxBytes of %s', (maxBytes) => {
    expect(() => provider(maxBytes)).toThrow(RangeError);
  });
});
