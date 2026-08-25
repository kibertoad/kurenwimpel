import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createSnapshot,
  FileFlagProvider,
  HttpFlagProvider,
  type FlagDefinition,
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

  it('loads segments from the document form of the ruleset', async () => {
    await writeFile(
      path,
      JSON.stringify({
        flags: ruleset,
        segments: [{ key: 'beta-testers', included: ['user-in'] }],
      }),
      'utf8',
    );

    const snapshot = await new FileFlagProvider({ path }).load();

    expect(snapshot?.flags.size).toBe(1);
    expect(snapshot?.segments.get('beta-testers')?.included.has('user-in')).toBe(true);
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

  it('stays quiet on a clean ruleset and survives issues with no listener', async () => {
    // The callback is for defects only — a clean poll must not ping it — and
    // its absence must not turn a reportable defect into a crashed refresh.
    const onParseIssues = vi.fn();
    await new FileFlagProvider({ path, onParseIssues }).load();
    expect(onParseIssues).not.toHaveBeenCalled();

    await writeFile(path, JSON.stringify([...ruleset, { key: 'bad' }]), 'utf8');
    const snapshot = await new FileFlagProvider({ path }).load();
    expect(snapshot?.flags.size).toBe(1);
  });

  it('carries the JSON error as the cause of the rejection', async () => {
    await writeFile(path, '{ not json', 'utf8');

    const failure = await new FileFlagProvider({ path }).load().catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).cause).toBeInstanceOf(SyntaxError);
  });

  it('is named for what it reads', () => {
    // The name reaches ClientErrorInfo, so an alert can say which source failed.
    expect(new FileFlagProvider({ path: 'flags.json' }).name).toBe('file');
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

  it('treats 304 as unchanged when it answers a conditional request', async () => {
    const provider = new HttpFlagProvider({
      url: 'https://flags.test/current',
      fetch: () => Promise.resolve(new Response(null, { status: 304 })),
    });

    expect(await provider.load(createSnapshot([], { version: 'rev-1' }))).toBeNull();
  });

  it('rejects a 304 answering the very first request', async () => {
    // Nothing was asked, so "unchanged" answers nothing — and with no snapshot
    // behind it, reporting it as unchanged leaves the client with no ruleset.
    const provider = new HttpFlagProvider({
      url: 'https://flags.test/current',
      fetch: () => Promise.resolve(new Response(null, { status: 304 })),
    });

    await expect(provider.load()).rejects.toThrow(/unconditional request/u);
  });

  it('treats a 304 as unchanged whenever there is a snapshot to keep serving', async () => {
    // A control plane that stops stamping ETags leaves the snapshot versionless,
    // so no If-None-Match goes out — and a caching proxy can still answer 304.
    // Keying the rejection off the validator rather than off "is there a
    // snapshot at all" turned that into an onError on every single poll,
    // forever, for a client that was serving exactly the right flags.
    const provider = new HttpFlagProvider({
      url: 'https://flags.test/current',
      fetch: () => Promise.resolve(new Response(null, { status: 304 })),
    });

    expect(await provider.load(createSnapshot([]))).toBeNull();
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

  it('leaves the snapshot versionless when the response carries no ETag', async () => {
    // A null version and a missing one are different on the next request:
    // only a missing one suppresses If-None-Match cleanly.
    const snapshot = await new HttpFlagProvider({
      url: 'https://flags.test/current',
      fetch: spyFetch(() => respond(ruleset)),
    }).load();

    expect(snapshot?.version).toBeUndefined();
  });

  it('surfaces parse issues, stays quiet on a clean payload, and needs no listener', async () => {
    const onParseIssues = vi.fn();
    const url = 'https://flags.test/current';

    const withIssues = await new HttpFlagProvider({
      url,
      fetch: spyFetch(() => respond([...ruleset, { key: 'bad' }])),
      onParseIssues,
    }).load();
    expect(withIssues?.flags.size).toBe(1);
    expect(onParseIssues).toHaveBeenCalledOnce();

    await new HttpFlagProvider({
      url,
      fetch: spyFetch(() => respond(ruleset)),
      onParseIssues,
    }).load();
    expect(onParseIssues).toHaveBeenCalledOnce();

    // No listener: the defect is dropped, not thrown into the refresh.
    const silent = await new HttpFlagProvider({
      url,
      fetch: spyFetch(() => respond([...ruleset, { key: 'bad' }])),
    }).load();
    expect(silent?.flags.size).toBe(1);
  });

  it('is named for what it polls', () => {
    expect(new HttpFlagProvider({ url: 'https://flags.test' }).name).toBe('http');
  });
});
