import { FeatureFlagClient, PollingFlagClient, StaticProvider } from '@kurenwimpel/node';
import { afterEach, expect, it, vi } from 'vitest';

import { createOfrepHandler } from '../src/index.js';
import { listen } from './node-server.js';
import { FLAGS } from './support.js';

const TOKEN = 'Bearer stream-token';
const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const step of cleanup.splice(0).toReversed()) {
    // oxlint-disable-next-line no-await-in-loop
    await step();
  }
});

// A published change, over a real socket, into a Node client that would otherwise poll once a minute.
it('reaches a connected PollingFlagClient in under a second', async () => {
  const controlPlane = new StaticProvider(FLAGS, { version: 'v1' });
  const served = new FeatureFlagClient({ provider: controlPlane });
  await served.init();

  const server = await listen(
    createOfrepHandler({
      client: () => served,
      authorize: (request) => request.headers.get('authorization') === TOKEN,
      eventStream: {},
    }),
  );
  cleanup.push(() => server.close());

  const load = vi.fn(() => controlPlane.load());
  const node = new PollingFlagClient({
    provider: { name: 'control-plane', load },
    pollIntervalMs: 60_000,
    changeStream: {
      url: `${server.url}/ofrep/v1/event-stream`,
      headers: { authorization: TOKEN },
    },
  });
  cleanup.push(() => node.close());
  await node.start();
  // The second load is the catch-up refresh the client makes once the stream connects.
  await vi.waitFor(() => {
    expect(load).toHaveBeenCalledTimes(2);
  });
  expect(node.getString('theme', 'unset')).toBe('dark');

  const publishedAt = performance.now();
  controlPlane.replace(
    [
      ...FLAGS.filter((flag) => flag.key !== 'theme'),
      {
        key: 'theme',
        enabled: true,
        variants: { light: 'light', dark: 'dark' },
        defaultVariant: 'light',
        offVariant: 'light',
      },
    ],
    { version: 'v2' },
  );
  await served.refresh();

  await vi.waitFor(
    () => {
      expect(node.getString('theme', 'unset')).toBe('light');
    },
    {
      timeout: 1000,
      interval: 5,
    },
  );
  expect(performance.now() - publishedAt).toBeLessThan(1000);
});
