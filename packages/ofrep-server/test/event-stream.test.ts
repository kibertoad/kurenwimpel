import { FeatureFlagClient, StaticProvider } from '@kurenwimpel/core';
import { sseEventDataSchema } from '@kurenwimpel/ofrep';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod/mini';

import { createOfrepHandler } from '../src/index.js';
import type { OfrepHandlerOptions } from '../src/index.js';
import { evaluateBulk, FLAGS, handlerFor, ORIGIN, post } from './support.js';

const STREAM = '/ofrep/v1/event-stream';
const decoder = new TextDecoder();

async function versionedClient(): Promise<{
  client: FeatureFlagClient;
  publish: (version: string) => Promise<void>;
}> {
  const provider = new StaticProvider(FLAGS, { version: 'v1', fetchedAt: 1_000_000 });
  const client = new FeatureFlagClient({ provider });
  await client.init();
  return {
    client,
    publish: async (version: string) => {
      provider.replace(FLAGS, { version, fetchedAt: 2_000_000 });
      await client.refresh();
    },
  };
}

function get(path: string, init: RequestInit = {}): Request {
  return new Request(`${ORIGIN}${path}`, init);
}

async function open(
  options: Partial<OfrepHandlerOptions> & { client: () => FeatureFlagClient },
  init: RequestInit = {},
): Promise<{ response: Response; read(): Promise<string>; cancel(): Promise<void> }> {
  const handler = createOfrepHandler({ authorize: () => true, eventStream: {}, ...options });
  const response = await handler(get(STREAM, init));
  const reader = response.body!.getReader();
  return {
    response,
    async read() {
      const { done, value } = await reader.read();
      return done ? '<end>' : decoder.decode(value);
    },
    cancel: () => reader.cancel(),
  };
}

describe('GET /ofrep/v1/event-stream', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends refetchEvaluation with lastModified when the served version changes', async () => {
    const { client, publish } = await versionedClient();
    const stream = await open({ client: () => client });

    expect(stream.response.headers.get('content-type')).toBe('text/event-stream');
    expect(await stream.read()).toBe(': connected\n\n');

    await vi.advanceTimersByTimeAsync(1000);
    await publish('v2');
    await vi.advanceTimersByTimeAsync(250);

    const event = await stream.read();
    expect(event).toBe('data: {"type":"refetchEvaluation","lastModified":2000}\n\n');
    const data: unknown = JSON.parse(event.slice('data: '.length));
    expect(z.safeParse(sseEventDataSchema, data).success).toBe(true);
  });

  it('stays quiet while a refresh brings the same version', async () => {
    const { client, publish } = await versionedClient();
    const stream = await open({ client: () => client, eventStream: { heartbeatIntervalMs: 5000 } });
    await stream.read();

    await vi.advanceTimersByTimeAsync(1000);
    await publish('v1');
    await vi.advanceTimersByTimeAsync(4000);

    expect(await stream.read()).toBe(': heartbeat\n\n');
  });

  it('sends a comment heartbeat on the configured interval', async () => {
    const { client } = await versionedClient();
    const stream = await open({ client: () => client, eventStream: { heartbeatIntervalMs: 1000 } });
    await stream.read();

    await vi.advanceTimersByTimeAsync(2000);

    expect([await stream.read(), await stream.read()]).toEqual([
      ': heartbeat\n\n',
      ': heartbeat\n\n',
    ]);
  });

  it('stops reading the client once the last stream is gone', async () => {
    const { client } = await versionedClient();
    const getClient = vi.fn(() => client);
    const stream = await open({ client: getClient });
    await vi.advanceTimersByTimeAsync(1000);
    expect(getClient.mock.calls.length).toBeGreaterThan(1);

    await stream.cancel();
    getClient.mockClear();
    await vi.advanceTimersByTimeAsync(5000);

    expect(getClient).not.toHaveBeenCalled();
  });

  it('closes the stream when the request is aborted', async () => {
    const { client } = await versionedClient();
    const controller = new AbortController();
    const stream = await open({ client: () => client }, { signal: controller.signal });
    await stream.read();

    controller.abort();

    expect(await stream.read()).toBe('<end>');
  });

  it('reports a client that fails to load through onError', async () => {
    const onError = vi.fn();
    const stream = await open({
      client: () => {
        throw new Error('no client');
      },
      onError,
    });
    await stream.read();

    await vi.advanceTimersByTimeAsync(250);

    expect(onError).toHaveBeenCalledWith(new Error('no client'));
  });
});

describe('eventStream option', () => {
  it('makes the bulk route advertise the stream below basePath', async () => {
    const { client } = await versionedClient();
    const handler = handlerFor(client, {
      basePath: '/flags',
      eventStream: { path: '/changes', inactivityDelaySec: 60 },
    });

    const response = await evaluateBulk(
      handler,
      { context: { targetingKey: 'u' } },
      { path: '/flags/ofrep/v1/evaluate/flags' },
    );

    expect(response.body).toMatchObject({
      eventStreams: [
        { type: 'sse', endpoint: { requestUri: '/flags/changes' }, inactivityDelaySec: 60 },
      ],
    });
  });

  it('serves no stream and advertises none when absent', async () => {
    const { client } = await versionedClient();
    const handler = handlerFor(client);

    const bulk = await evaluateBulk(handler, { context: { targetingKey: 'u' } });

    expect(bulk.body).not.toHaveProperty('eventStreams');
    expect((await handler(get(STREAM))).status).toBe(404);
  });

  it('answers 405 to a POST and runs authorize on the stream', async () => {
    const { client } = await versionedClient();
    const handler = handlerFor(client, { eventStream: {}, authorize: () => false });

    expect((await handler(post(STREAM, {}))).status).toBe(405);
    expect((await handler(get(STREAM))).status).toBe(401);
  });

  it('wins over the flag route for a path under its prefix', async () => {
    const { client } = await versionedClient();
    const path = '/ofrep/v1/evaluate/flags/events';
    const handler = handlerFor(client, { eventStream: { path } });

    const response = await handler(get(path));

    expect(response.headers.get('content-type')).toBe('text/event-stream');
    await response.body!.cancel();
  });

  it.each([
    [{ heartbeatIntervalMs: 120_000 }],
    [{ heartbeatIntervalMs: 0 }],
    [{ inactivityDelaySec: 0 }],
    [{ inactivityDelaySec: 1.5 }],
  ])('rejects %o', async (eventStream) => {
    const { client } = await versionedClient();

    expect(() => handlerFor(client, { eventStream })).toThrow(TypeError);
  });
});
