import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_FLAGS_KEY, KvFlagProvider, WorkerFlags } from '../src/index.js';
import type { FlagDefinition, ImpressionEvent, WorkerFlagsOptions } from '../src/index.js';

const checkout: FlagDefinition = {
  key: 'new-checkout',
  enabled: true,
  variants: { on: true, off: false },
  defaultVariant: 'on',
  offVariant: 'off',
};

const FLUSH_INTERVAL_MS = 1000;

function workerFlags(options: Partial<WorkerFlagsOptions> = {}) {
  const flush = vi.fn((_events: ImpressionEvent[]) => Promise.resolve());
  const flags = new WorkerFlags({
    provider: new KvFlagProvider({ namespace: env.FLAGS }),
    impressions: { flush, flushIntervalMs: FLUSH_INTERVAL_MS },
    ...options,
  });
  return { flags, flush };
}

/** One request: evaluate for each subject, then let `waitUntil` work settle. */
async function serve(flags: WorkerFlags, subjects: string[]): Promise<void> {
  const ctx = createExecutionContext();
  const client = await flags.get(ctx);
  for (const targetingKey of subjects) client.getBoolean('new-checkout', false, { targetingKey });
  await waitOnExecutionContext(ctx);
}

beforeEach(async () => {
  await env.FLAGS.put(DEFAULT_FLAGS_KEY, JSON.stringify([checkout]));
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(0);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await env.FLAGS.delete(DEFAULT_FLAGS_KEY);
});

describe('WorkerFlags impressions', () => {
  it('hands a flush to ctx.waitUntil once the interval has passed', async () => {
    const { flags, flush } = workerFlags();

    await serve(flags, ['user-1', 'user-1', 'user-2']);
    expect(flush).not.toHaveBeenCalled();

    vi.setSystemTime(FLUSH_INTERVAL_MS - 1);
    await serve(flags, []);
    expect(flush).not.toHaveBeenCalled();

    vi.setSystemTime(FLUSH_INTERVAL_MS);
    const ctx = createExecutionContext();
    const waitUntil = vi.spyOn(ctx, 'waitUntil');
    await flags.get(ctx);
    await waitOnExecutionContext(ctx);

    expect(waitUntil).toHaveBeenCalled();
    expect(flush).toHaveBeenCalledOnce();
    expect(flush.mock.calls[0]?.[0].map((event) => event.targetingKey)).toEqual([
      'user-1',
      'user-2',
    ]);
    expect(flags.impressionStats()).toMatchObject({ flushed: 2, deduplicated: 1, queued: 0 });
  });

  it('schedules nothing while the queue is empty', async () => {
    const { flags, flush } = workerFlags();
    await serve(flags, []);

    vi.setSystemTime(FLUSH_INTERVAL_MS * 5);
    await serve(flags, []);

    expect(flush).not.toHaveBeenCalled();
  });

  it('flushes on demand through flushImpressions', async () => {
    const { flags, flush } = workerFlags();
    await serve(flags, ['user-1']);

    await flags.flushImpressions();

    expect(flush).toHaveBeenCalledOnce();
  });

  it('reports a failed batch through onError and drops it', async () => {
    const onError = vi.fn();
    const { flags } = workerFlags({
      onError,
      impressions: {
        flush: () => Promise.reject(new Error('sink down')),
        flushIntervalMs: FLUSH_INTERVAL_MS,
      },
    });
    await serve(flags, ['user-1']);

    vi.setSystemTime(FLUSH_INTERVAL_MS);
    await serve(flags, []);

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'sink down' }));
    expect(flags.impressionStats()).toMatchObject({ failed: 1, queued: 0 });
  });

  it('keeps calling onImpression for every evaluation', async () => {
    const onImpression = vi.fn();
    const { flags } = workerFlags({ onImpression });

    await serve(flags, ['user-1', 'user-1']);

    expect(onImpression).toHaveBeenCalledTimes(2);
    expect(flags.impressionStats()).toMatchObject({ queued: 1, deduplicated: 1 });
  });
});
