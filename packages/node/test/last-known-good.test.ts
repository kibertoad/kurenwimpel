import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FileFlagProvider,
  FileLastKnownGoodStore,
  HttpFlagProvider,
  PollingFlagClient,
  type ClientErrorInfo,
  type FlagDefinition,
} from '../src/index.js';

const checkout = (enabled: boolean): FlagDefinition => ({
  key: 'new-checkout',
  enabled,
  variants: { on: true, off: false },
  defaultVariant: 'on',
  offVariant: 'off',
});

const down = () => Promise.reject(new TypeError('fetch failed'));

let dir: string;
let storePath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kurenwimpel-lkg-'));
  storePath = join(dir, 'state', 'last-known-good.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('FileLastKnownGoodStore', () => {
  it('reads nothing before the first write', async () => {
    expect(await new FileLastKnownGoodStore({ path: storePath }).read()).toBeNull();
  });

  it('round-trips a ruleset and leaves no temporary file behind', async () => {
    const store = new FileLastKnownGoodStore({ path: storePath });
    const ruleset = { raw: [checkout(true)], version: 'rev-1', fetchedAt: 42 };

    await Promise.all([store.write(ruleset), store.write({ ...ruleset, version: 'rev-2' })]);

    expect(await store.read()).toEqual({ ...ruleset, version: 'rev-2' });
    expect(await readdir(join(dir, 'state'))).toEqual(['last-known-good.json']);
  });

  it('rejects a file that is not a stored ruleset', async () => {
    const store = new FileLastKnownGoodStore({ path: storePath });
    await store.write({ raw: [], fetchedAt: 1 });
    await writeFile(storePath, '{"raw": []}', 'utf8');

    await expect(store.read()).rejects.toThrow('does not hold a stored ruleset');
  });
});

describe('HttpFlagProvider with a last-known-good store', () => {
  const url = 'https://flags.test/current';

  async function seedStore(): Promise<void> {
    await new FileLastKnownGoodStore({ path: storePath }).write({
      raw: [checkout(false)],
      version: '"rev-1"',
      fetchedAt: 42,
    });
  }

  function pollingClient(fetch: typeof globalThis.fetch) {
    const onError = vi.fn<(error: Error, info: ClientErrorInfo) => void>();
    const lastKnownGood = new FileLastKnownGoodStore({ path: storePath });
    const provider = new HttpFlagProvider({ url, fetch, lastKnownGood });
    return { client: new PollingFlagClient({ provider, onError }), onError };
  }

  it('starts on the stored flags while the endpoint is down', async () => {
    await seedStore();
    const { client, onError } = pollingClient(down);

    await client.start();

    expect(client.ready).toBe(true);
    expect(client.getBoolean('new-checkout', true)).toBe(false);
    expect(client.snapshot.origin).toBe('fallback');
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(TypeError);
    await client.close();
  });

  it('flips to live on a 304 against the stored ETag', async () => {
    await seedStore();
    const fetch = vi.fn<typeof globalThis.fetch>(down);
    const { client } = pollingClient(fetch);
    await client.start();

    fetch.mockResolvedValue(new Response(null, { status: 304 }));
    await client.refresh();

    const headers = fetch.mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(headers['if-none-match']).toBe('"rev-1"');
    expect(client.snapshot.origin).toBe('live');
    await client.close();
  });

  it('stores what it fetches and replaces the fallback with it', async () => {
    await seedStore();
    const fetch = vi.fn<typeof globalThis.fetch>(down);
    const { client } = pollingClient(fetch);
    await client.start();

    fetch.mockResolvedValue(Response.json([checkout(true)], { headers: { etag: '"rev-2"' } }));
    await client.refresh();

    expect(client.getBoolean('new-checkout', false)).toBe(true);
    expect(client.snapshot.origin).toBe('live');
    await vi.waitFor(async () => {
      const stored = JSON.parse(await readFile(storePath, 'utf8')) as { version: string };
      expect(stored.version).toBe('"rev-2"');
    });
    await client.close();
  });

  it('rejects start with the original error when the store is corrupt', async () => {
    await seedStore();
    await writeFile(storePath, '{ truncated', 'utf8');
    const { client, onError } = pollingClient(down);

    await expect(client.start()).rejects.toThrow('fetch failed');
    expect(onError).not.toHaveBeenCalled();
    await client.close();
  });
});

describe('FileFlagProvider with a last-known-good store', () => {
  it('boots from the store when the flag file is missing', async () => {
    await new FileLastKnownGoodStore({ path: storePath }).write({
      raw: [checkout(false)],
      fetchedAt: 42,
    });
    const provider = new FileFlagProvider({
      path: join(dir, 'missing.json'),
      lastKnownGood: new FileLastKnownGoodStore({ path: storePath }),
    });

    const snapshot = await provider.load();

    expect(snapshot?.origin).toBe('fallback');
    expect(snapshot?.flags.get('new-checkout')?.enabled).toBe(false);
  });
});
