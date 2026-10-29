import { bench, describe } from 'vitest';

import { FeatureFlagClient, StaticProvider } from '../src/index.js';
import { CONTEXT, mixedRuleset } from './fixtures.js';

const client = new FeatureFlagClient({ provider: new StaticProvider(mixedRuleset(500).flags) });
await client.init();

describe('FeatureFlagClient.evaluateAll', () => {
  bench('500 flags', () => {
    client.evaluateAll(CONTEXT);
  });
});
