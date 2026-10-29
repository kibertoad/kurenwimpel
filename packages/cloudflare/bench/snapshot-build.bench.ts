import { bench, describe } from 'vitest';

import { buildSnapshot } from '../../core/bench/build.js';
import { snapshotPayloads } from '../../core/bench/fixtures.js';

// Same guard as the test suite: numbers from a Node fallback would be mislabelled.
if (navigator.userAgent !== 'Cloudflare-Workers') {
  throw new Error(`Expected to run inside workerd, got "${navigator.userAgent}"`);
}

const payloads = snapshotPayloads();

describe('workerd: parse and build a snapshot from JSON', () => {
  for (const [label, payload] of payloads) {
    bench(label, () => {
      buildSnapshot(payload);
    });
  }
});
