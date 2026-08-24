import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createSnapshot,
  FileFlagProvider,
  HttpFlagProvider,
  PollingFlagClient,
  type FlagDefinition,
  type FlagProvider,
} from '../src/index.js';

const ruleset: FlagDefinition[] = [
  {
    key: 'new-checkout',
    enabled: true,
    variants: { on: true, off: false },
    defaultVariant: 'on',
    offVariant: 'off',
  },
];

describe('FileFlagProvider', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kurenwimpel-'));
    path = join(dir, 'flags.json');
    await writeFile(path, JSON.stringify(ruleset), 'utf8');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('loads and parses the file', async () => {
    const snapshot = await new FileFlagProvider({ path }).load();
    expect(snapshot?.flags.get('new-checkout')?.enabled).toBe(true);
  });

  it('reports no change when mtime and size are untouched', async () => {
    const provider = new FileFlagProvider({ path });
    const first = await provider.load();

    expect(await provider.load(first ?? undefined)).toBeNull();
  });

  it('reloads once the file changes', async () => {
    const provider = new FileFlagProvider({ path });
    const first = await provider.load();

    await writeFile(path, JSON.stringify([{ ...ruleset[0], enabled: false }]), 'utf8');

    const second = await provider.load(first ?? undefined);
    expect(second?.flags.get('new-checkout')?.enabled).toBe(false);
  });

  it('reports invalid JSON with the offending path', async () => {
    await writeFile(path, '{ not json', 'utf8');
    await expect(new FileFlagProvider({ path }).load()).rejects.toThrow(/not valid JSON/u);
  });

  it('rejects when the file is missing', async () => {
    await expect(new FileFlagProvider({ path: join(dir, 'absent.json') }).load()).rejects.toThrow();
  });

  it('surfaces parse issues while keeping the valid flags', async () => {
    const onParseIssues = vi.fn();
    await writeFile(path, JSON.stringify([...ruleset, { key: 'bad' }]), 'utf8');

    const snapshot = await new FileFlagProvider({ path, onParseIssues }).load();

    expect(snapshot?.flags.size).toBe(1);
    expect(onParseIssues).toHaveBeenCalledOnce();
  });
});

const respond = (body: unknown, init?: ResponseInit): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });

/** Typed so `mock.calls` keeps the url and init the provider sent. */
const spyFetch = (handler: () => Response) =>
  vi.fn((_url: string | URL | Request, _init?: RequestInit) => Promise.resolve(handler()));

describe('HttpFlagProvider', () => {
  it('fetches and parses the ruleset', async () => {
    const fetchMock = spyFetch(() => respond(ruleset));
    const snapshot = await new HttpFlagProvider({
      url: 'https://flags.test/current',
      fetch: fetchMock,
    }).load();

    expect(snapshot?.flags.get('new-checkout')?.enabled).toBe(true);
  });

  it('records the ETag and sends it back as If-None-Match', async () => {
    const fetchMock = spyFetch(() => respond(ruleset, { headers: { etag: 'W/"rev-3"' } }));
    const provider = new HttpFlagProvider({
      url: 'https://flags.test/current',
      fetch: fetchMock,
    });

    const first = await provider.load();
    expect(first?.version).toBe('W/"rev-3"');

    await provider.load(first ?? undefined);

    const headers = fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(headers['if-none-match']).toBe('W/"rev-3"');
  });

  it('treats 304 as unchanged', async () => {
    const provider = new HttpFlagProvider({
      url: 'https://flags.test/current',
      fetch: () => Promise.resolve(new Response(null, { status: 304 })),
    });

    expect(await provider.load({ flags: new Map(), version: 'rev-1', fetchedAt: 0 })).toBeNull();
  });

  it('throws on a non-ok response', async () => {
    const provider = new HttpFlagProvider({
      url: 'https://flags.test/current',
      fetch: () => Promise.resolve(new Response('nope', { status: 503 })),
    });

    await expect(provider.load()).rejects.toThrow(/responded 503/u);
  });

  it('merges custom headers into the request', async () => {
    const fetchMock = spyFetch(() => respond(ruleset));
    await new HttpFlagProvider({
      url: 'https://flags.test/current',
      headers: { authorization: 'Bearer token' },
      fetch: fetchMock,
    }).load();

    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.headers).toMatchObject({
      accept: 'application/json',
      authorization: 'Bearer token',
    });
  });
});

describe('PollingFlagClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads on start and reloads on the interval', async () => {
    let revision = 1;
    const load = vi.fn(() =>
      Promise.resolve(createSnapshot(ruleset, { version: `rev-${revision++}`, fetchedAt: 0 })),
    );

    const client = new PollingFlagClient({
      provider: { name: 'test', load } satisfies FlagProvider,
      pollIntervalMs: 1000,
    });

    await client.start();
    expect(client.getBoolean('new-checkout', false)).toBe(true);
    expect(load).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(2500);
    expect(load).toHaveBeenCalledTimes(3);

    await client.close();
  });

  it('stops polling after close', async () => {
    const load = vi.fn(() => Promise.resolve(createSnapshot([], { fetchedAt: 0 })));
    const close = vi.fn(() => Promise.resolve());

    const client = new PollingFlagClient({
      provider: { name: 'test', load, close } satisfies FlagProvider,
      pollIntervalMs: 1000,
    });

    await client.start();
    await client.close();

    await vi.advanceTimersByTimeAsync(5000);

    expect(load).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('rejects from start when the first load fails', async () => {
    const client = new PollingFlagClient({
      provider: {
        name: 'test',
        load: () => Promise.reject(new Error('down')),
      } satisfies FlagProvider,
    });

    await expect(client.start()).rejects.toThrow('down');
  });

  it('keeps serving the stale snapshot when a poll fails', async () => {
    let calls = 0;
    const onError = vi.fn();
    const client = new PollingFlagClient({
      provider: {
        name: 'test',
        load: () => {
          calls += 1;
          return calls === 1
            ? Promise.resolve(createSnapshot(ruleset, { version: 'rev-1', fetchedAt: 0 }))
            : Promise.reject(new Error('control plane down'));
        },
      } satisfies FlagProvider,
      pollIntervalMs: 1000,
      onError,
    });

    await client.start();
    await vi.advanceTimersByTimeAsync(1500);

    expect(client.getBoolean('new-checkout', false)).toBe(true);
    expect(onError).toHaveBeenCalled();

    await client.close();
  });
});
