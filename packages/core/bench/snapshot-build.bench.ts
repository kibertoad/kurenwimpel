import { afterAll, bench, describe } from 'vitest';

import { buildSnapshot } from './build.js';
import { snapshotPayloads } from './fixtures.js';
import { reportRetainedHeap } from './heap.js';

const payloads = snapshotPayloads();

describe('parse and build a snapshot from JSON', () => {
  for (const [label, payload] of payloads) {
    bench(label, () => {
      buildSnapshot(payload);
    });
  }
});

// Top level: vitest bench does not run hooks registered inside a `describe`.
afterAll(() => {
  for (const [label, payload] of payloads) {
    reportRetainedHeap(label, () => buildSnapshot(payload));
  }
});
