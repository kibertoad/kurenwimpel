import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import type { MetricData } from '@opentelemetry/sdk-metrics';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FeatureFlagClient, StaticProvider } from '../src/index.js';
import type { FlagProvider } from '../src/index.js';
import { OpenTelemetryMetrics } from '../src/opentelemetry.js';

const flag = {
  key: 'new-checkout',
  enabled: true,
  variants: { on: true, off: false },
  defaultVariant: 'on',
  offVariant: 'off',
};

let exporter: InMemoryMetricExporter;
let reader: PeriodicExportingMetricReader;
let provider: MeterProvider;

beforeEach(() => {
  exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 });
  provider = new MeterProvider({ readers: [reader] });
});

afterEach(async () => {
  vi.useRealTimers();
  await provider.shutdown();
});

async function exported(name: string): Promise<MetricData | undefined> {
  await reader.forceFlush();
  const batches = exporter.getMetrics();
  const metrics = batches.at(-1)?.scopeMetrics.flatMap((scope) => scope.metrics) ?? [];
  return metrics.find((metric) => metric.descriptor.name === name);
}

describe('OpenTelemetryMetrics', () => {
  it('counts evaluations with feature-flag semconv attributes', async () => {
    const metrics = new OpenTelemetryMetrics(provider.getMeter('flags'));
    const client = new FeatureFlagClient({ provider: new StaticProvider([flag]), metrics });
    await client.init();

    client.getBoolean('new-checkout', false);
    client.getBoolean('new-checkout', false);
    client.getBoolean('missing', false);

    const points = (await exported('flag.evaluations'))?.dataPoints ?? [];

    expect(points.map(({ attributes, value }) => ({ attributes, value }))).toEqual([
      {
        attributes: {
          'feature_flag.key': 'new-checkout',
          'feature_flag.result.reason': 'static',
          'feature_flag.result.variant': 'on',
        },
        value: 2,
      },
      {
        attributes: {
          'feature_flag.key': 'missing',
          'feature_flag.result.reason': 'error',
          'error.type': 'flag_not_found',
        },
        value: 1,
      },
    ]);
  });

  it('reports snapshot age from the last successful load and the failure total', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(10_000);
    const answers = [Promise.resolve(new StaticProvider([flag]).load()), Promise.resolve(null)];
    const scripted: FlagProvider = {
      name: 'scripted',
      load: () => answers.shift() ?? Promise.reject(new Error('down')),
    };
    const metrics = new OpenTelemetryMetrics(provider.getMeter('flags'));
    const client = new FeatureFlagClient({ provider: scripted, metrics, onError: () => {} });
    metrics.observe(client);

    await client.init();
    vi.setSystemTime(40_000);
    await client.refresh();
    await client.refresh();
    vi.setSystemTime(55_000);

    const attributes = { 'feature_flag.provider.name': 'scripted' };
    const age = await exported('flag.snapshot.age');
    const failures = await exported('flag.load.failures');

    expect(age?.dataPoints).toMatchObject([{ attributes, value: 15 }]);
    expect(failures?.dataPoints).toMatchObject([{ attributes, value: 1 }]);
  });

  it('stops observing when the returned function is called', async () => {
    const metrics = new OpenTelemetryMetrics(provider.getMeter('flags'));
    const client = new FeatureFlagClient({ provider: new StaticProvider([flag]) });
    await client.init();

    const stop = metrics.observe(client);
    stop();

    expect((await exported('flag.snapshot.age'))?.dataPoints ?? []).toEqual([]);
  });
});
