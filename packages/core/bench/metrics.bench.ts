import { afterAll, bench, describe } from 'vitest';

import { CountingMetrics, FeatureFlagClient, StaticProvider } from '../src/index.js';
import type { MetricsSink } from '../src/index.js';
import { buildSnapshot } from './build.js';
import { CONTEXT, trivialFlag } from './fixtures.js';
import { reportAllocation } from './heap.js';

const snapshot = buildSnapshot(JSON.stringify({ flags: [trivialFlag('trivial')] }));
const noop: MetricsSink = { record: () => {} };
const counting = new CountingMetrics();

function client(metrics?: MetricsSink): FeatureFlagClient {
  const created = new FeatureFlagClient({
    provider: new StaticProvider(),
    ...(metrics === undefined ? {} : { metrics }),
  });
  created.setSnapshot(snapshot);
  return created;
}

const variants: [string, () => void][] = [
  ['getBoolean, no metrics', evaluateWith(client())],
  ['getBoolean, no-op sink', evaluateWith(client(noop))],
  ['getBoolean, CountingMetrics', evaluateWith(client(counting))],
  [
    'CountingMetrics.record alone',
    () => {
      counting.record('trivial', 'on', 'STATIC');
    },
  ],
];

function evaluateWith(target: FeatureFlagClient): () => void {
  return () => {
    target.getBoolean('trivial', false, CONTEXT);
  };
}

describe('evaluation with a metrics sink', () => {
  for (const [label, run] of variants) {
    bench(label, run);
  }
});

// Top level: vitest bench does not run hooks registered inside a `describe`.
afterAll(() => {
  const calls = 2000;
  for (const [label, run] of variants) {
    for (let warmup = 0; warmup < 50_000; warmup += 1) run();
    reportAllocation(label, run, calls);
  }
});
