import { describe, expect, it, vi } from 'vitest';

import { createImpressionBatcher, EvaluationReason } from '../../src/index.js';
import type { ImpressionBatcherOptions, ImpressionEvent } from '../../src/index.js';

type Overrides = { [K in keyof ImpressionEvent]?: ImpressionEvent[K] | undefined };

function impression(overrides: Overrides = {}): ImpressionEvent {
  return {
    flagKey: 'new-checkout',
    value: true,
    variant: 'on',
    reason: EvaluationReason.TargetingMatch,
    targetingKey: 'user-1',
    flagVersion: 1,
    timestamp: 1000,
    ...overrides,
  } as ImpressionEvent;
}

function recordingBatcher(options: Partial<ImpressionBatcherOptions> = {}) {
  const batches: ImpressionEvent[][] = [];
  const batcher = createImpressionBatcher({
    flush: (events) => {
      batches.push(events);
      return Promise.resolve();
    },
    ...options,
  });
  return { batcher, batches };
}

describe('createImpressionBatcher deduplication', () => {
  it('drops a repeat of the same key inside the window', async () => {
    const { batcher, batches } = recordingBatcher({ dedupWindowMs: 1000 });

    batcher.onImpression(impression({ timestamp: 1000 }));
    batcher.onImpression(impression({ timestamp: 1999 }));
    await batcher.flush();

    expect(batches.flat()).toHaveLength(1);
    expect(batcher.stats()).toMatchObject({ deduplicated: 1, flushed: 1 });
  });

  it('emits the same key again once the window has passed', async () => {
    const { batcher, batches } = recordingBatcher({ dedupWindowMs: 1000 });

    batcher.onImpression(impression({ timestamp: 1000 }));
    batcher.onImpression(impression({ timestamp: 1500 }));
    batcher.onImpression(impression({ timestamp: 2000 }));
    await batcher.flush();

    expect(batches.flat().map((event) => event.timestamp)).toEqual([1000, 2000]);
  });

  it.each([
    ['variant', { variant: 'off', value: false }],
    ['flag version', { flagVersion: 2 }],
    ['targeting key', { targetingKey: 'user-2' }],
    ['flag key', { flagKey: 'banner' }],
  ] as const)('always emits a change of %s', async (_field, change) => {
    const { batcher, batches } = recordingBatcher();

    batcher.onImpression(impression());
    batcher.onImpression(impression({ ...change, timestamp: 1001 }));
    await batcher.flush();

    expect(batches.flat()).toHaveLength(2);
    expect(batcher.stats().deduplicated).toBe(0);
  });

  it('emits a variant flip back and forth every time', async () => {
    const { batcher, batches } = recordingBatcher();

    for (const [index, variant] of ['on', 'off', 'on', 'off'].entries()) {
      batcher.onImpression(impression({ variant, timestamp: 1000 + index }));
    }
    await batcher.flush();

    expect(batches.flat().map((event) => event.variant)).toEqual(['on', 'off', 'on', 'off']);
  });

  it('ignores fields outside the key', async () => {
    const { batcher, batches } = recordingBatcher();

    batcher.onImpression(impression());
    batcher.onImpression(
      impression({ value: 'other', reason: EvaluationReason.Split, ruleId: 'r1', timestamp: 1001 }),
    );
    await batcher.flush();

    expect(batches.flat()).toHaveLength(1);
  });

  it('tells a missing variant or targeting key apart from the string "undefined"', async () => {
    const { batcher, batches } = recordingBatcher();

    batcher.onImpression(impression({ variant: undefined, targetingKey: undefined }));
    batcher.onImpression(impression({ variant: 'undefined', targetingKey: undefined }));
    batcher.onImpression(impression({ variant: 'undefined', targetingKey: 'undefined' }));
    await batcher.flush();

    expect(batches.flat()).toHaveLength(3);
  });

  it('does not deduplicate when the window is 0', async () => {
    const { batcher, batches } = recordingBatcher({ dedupWindowMs: 0 });

    batcher.onImpression(impression());
    batcher.onImpression(impression());
    await batcher.flush();

    expect(batches.flat()).toHaveLength(2);
  });

  it('forgets the oldest key past maxDedupKeys, letting a repeat through', async () => {
    const { batcher, batches } = recordingBatcher({ maxDedupKeys: 2 });

    batcher.onImpression(impression({ targetingKey: 'a' }));
    batcher.onImpression(impression({ targetingKey: 'b' }));
    batcher.onImpression(impression({ targetingKey: 'c' }));
    batcher.onImpression(impression({ targetingKey: 'a' }));
    batcher.onImpression(impression({ targetingKey: 'c' }));
    await batcher.flush();

    expect(batches.flat().map((event) => event.targetingKey)).toEqual(['a', 'b', 'c', 'a']);
  });
});

describe('createImpressionBatcher bounds', () => {
  it('drops the oldest events past maxQueueSize and counts them', async () => {
    const { batcher, batches } = recordingBatcher({ maxQueueSize: 3, dedupWindowMs: 0 });

    for (const targetingKey of ['a', 'b', 'c', 'd', 'e']) {
      batcher.onImpression(impression({ targetingKey }));
    }
    expect(batcher.stats()).toMatchObject({ queued: 3, dropped: 2 });

    await batcher.flush();
    expect(batches.flat().map((event) => event.targetingKey)).toEqual(['c', 'd', 'e']);
  });

  it('flushes on its own when the queue reaches maxBatchSize', async () => {
    const flush = vi.fn(() => Promise.resolve());
    const batcher = createImpressionBatcher({ flush, maxBatchSize: 2, dedupWindowMs: 0 });

    batcher.onImpression(impression());
    expect(flush).not.toHaveBeenCalled();
    batcher.onImpression(impression());
    await batcher.flush();

    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush.mock.calls[0]).toEqual([[impression(), impression()]]);
  });

  it('splits a large queue into batches of maxBatchSize, one at a time', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const sizes: number[] = [];
    const batcher = createImpressionBatcher({
      flush: async (events) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        sizes.push(events.length);
        await Promise.resolve();
        inFlight -= 1;
      },
      maxBatchSize: 2,
      maxQueueSize: 100,
      dedupWindowMs: 0,
    });

    for (let index = 0; index < 5; index += 1) batcher.onImpression(impression());
    await batcher.flush();

    expect(sizes).toEqual([2, 2, 1]);
    expect(maxInFlight).toBe(1);
  });
});

describe('createImpressionBatcher failures', () => {
  it('reports a failing batch through onError and drops it', async () => {
    const onError = vi.fn();
    const flush = vi.fn(() => Promise.reject(new Error('sink down')));
    const batcher = createImpressionBatcher({ flush, onError, dedupWindowMs: 0 });

    batcher.onImpression(impression());
    await batcher.flush();
    await batcher.flush();

    expect(flush).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'sink down' }));
    expect(batcher.stats()).toMatchObject({ queued: 0, failed: 1, flushed: 0 });
  });

  it('survives a sink that throws synchronously and an onError that throws', async () => {
    const batcher = createImpressionBatcher({
      flush: () => {
        throw new Error('sync');
      },
      onError: () => {
        throw new Error('hook');
      },
    });

    batcher.onImpression(impression());
    await expect(batcher.flush()).resolves.toBeUndefined();
    expect(batcher.stats().failed).toBe(1);
  });
});

describe('createImpressionBatcher close', () => {
  it('flushes what is queued and drops later events', async () => {
    const { batcher, batches } = recordingBatcher();

    batcher.onImpression(impression());
    await batcher.close();
    batcher.onImpression(impression({ variant: 'off' }));
    await batcher.flush();

    expect(batches).toEqual([[impression()]]);
    expect(batcher.stats()).toMatchObject({ flushed: 1, dropped: 1, queued: 0 });
  });
});
