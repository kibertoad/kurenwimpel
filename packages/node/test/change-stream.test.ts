import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSnapshot, PollingFlagClient } from '../src/index.js';
import type { FlagProvider, PollingFlagClientOptions } from '../src/index.js';
import { sseServer } from './sse-server.js';
import type { SseServer } from './sse-server.js';

const POLL_MS = 60_000;
const REFETCH = 'data: {"type":"refetchEvaluation","lastModified":1}\n\n';

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const step of cleanup.splice(0).toReversed()) {
    // oxlint-disable-next-line no-await-in-loop
    await step();
  }
  vi.restoreAllMocks();
});

async function serve(port?: number, status?: number): Promise<SseServer> {
  const server = await sseServer(port, status);
  cleanup.push(() => server.close());
  return server;
}

function countingProvider(): FlagProvider & { loads: number } {
  const provider = {
    name: 'counting',
    loads: 0,
    load() {
      provider.loads += 1;
      return Promise.resolve(createSnapshot([], { version: `v${provider.loads}`, fetchedAt: 0 }));
    },
  };
  return provider;
}

async function started(
  provider: FlagProvider,
  options: Partial<PollingFlagClientOptions>,
): Promise<PollingFlagClient> {
  const client = new PollingFlagClient({ provider, pollIntervalMs: POLL_MS, ...options });
  cleanup.push(() => client.close());
  await client.start();
  return client;
}

function streamTo(server: SseServer, query = ''): { url: string; maxReconnectDelayMs: number } {
  return { url: `http://127.0.0.1:${server.port}/events${query}`, maxReconnectDelayMs: 50 };
}

describe('changeStream', () => {
  it('refreshes on each refetch event and sends the configured headers', async () => {
    const server = await serve();
    const provider = countingProvider();
    await started(provider, {
      changeStream: { ...streamTo(server), headers: { authorization: 'Bearer t' } },
    });
    await vi.waitFor(() => {
      expect(server.open).toBe(1);
    });
    // The start load plus the catch-up refresh on connect.
    await vi.waitFor(() => {
      expect(provider.loads).toBe(2);
    });

    server.send(REFETCH);
    server.send('data: {"type":"somethingNew"}\n\n: heartbeat\n\n');
    await vi.waitFor(() => {
      expect(provider.loads).toBe(3);
    });

    expect(server.connections[0]).toMatchObject({
      accept: 'text/event-stream',
      authorization: 'Bearer t',
    });
  });

  it('polls slower while connected and at the normal interval once the server is gone', async () => {
    const intervals = vi.spyOn(globalThis, 'setInterval');
    const lastInterval = (): unknown => intervals.mock.calls.at(-1)?.[1];
    const server = await serve();

    await started(countingProvider(), { changeStream: streamTo(server) });
    await vi.waitFor(() => {
      expect(lastInterval()).toBe(POLL_MS * 10);
    });

    await server.close();
    await vi.waitFor(() => {
      expect(lastInterval()).toBe(POLL_MS);
    });

    const revived = await serve(server.port);
    await vi.waitFor(() => {
      expect(revived.open).toBe(1);
    });
    await vi.waitFor(() => {
      expect(lastInterval()).toBe(POLL_MS * 10);
    });
  });

  it('honours pollIntervalMultiplier', async () => {
    const intervals = vi.spyOn(globalThis, 'setInterval');
    const server = await serve();

    await started(countingProvider(), {
      changeStream: { ...streamTo(server), pollIntervalMultiplier: 3 },
    });

    await vi.waitFor(() => {
      expect(intervals.mock.calls.at(-1)?.[1]).toBe(POLL_MS * 3);
    });
  });

  it('reopens a connection that goes quiet for idleTimeoutMs', async () => {
    const server = await serve();

    await started(countingProvider(), {
      changeStream: { ...streamTo(server), idleTimeoutMs: 50 },
    });

    await vi.waitFor(() => {
      expect(server.connections.length).toBeGreaterThanOrEqual(3);
    });
  });

  it('never puts the URL in an error', async () => {
    const onError = vi.fn();
    const rejecting = await serve(undefined, 401);
    const dropping = await serve();

    await started(countingProvider(), {
      onError,
      changeStream: streamTo(rejecting, '?token=secret-a'),
    });
    await started(countingProvider(), {
      onError,
      changeStream: streamTo(dropping, '?token=secret-b'),
    });
    await vi.waitFor(() => {
      expect(dropping.open).toBe(1);
    });
    await dropping.close();
    await vi.waitFor(() => {
      expect(onError.mock.calls.length).toBeGreaterThanOrEqual(4);
    });

    const messages = onError.mock.calls.map(([error]) => {
      const { message, cause } = error as Error;
      return `${message} ${String(cause)}`;
    });
    expect(messages.join('\n')).not.toMatch(/secret|127\.0\.0\.1/u);
    expect(messages).toContain('Change stream answered 401 undefined');
    expect(onError.mock.calls[0]?.[1]).toEqual({ operation: 'stream', provider: 'counting' });
  });

  it('rejects an invalid URL without repeating it', () => {
    expect(
      () =>
        new PollingFlagClient({
          provider: countingProvider(),
          changeStream: { url: 'not a url secret' },
        }),
    ).toThrow(new TypeError('changeStream.url is not a valid URL'));
  });

  it('closes the connection on close()', async () => {
    const server = await serve();
    const client = await started(countingProvider(), { changeStream: streamTo(server) });
    await vi.waitFor(() => {
      expect(server.open).toBe(1);
    });

    await client.close();

    await vi.waitFor(() => {
      expect(server.open).toBe(0);
    });
    expect(server.connections).toHaveLength(1);
  });
});
