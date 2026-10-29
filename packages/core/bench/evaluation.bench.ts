import { bench, describe } from 'vitest';

import { evaluateFlag } from '../src/index.js';
import type { FlagDefinition } from '../src/index.js';
import { buildSnapshot } from './build.js';
import {
  CONTEXT,
  prerequisiteChain,
  ruleHeavyFlag,
  segmentRuleset,
  trivialFlag,
} from './fixtures.js';

const withSegment = segmentRuleset(100_000);
const snapshot = buildSnapshot(
  JSON.stringify({
    flags: [
      trivialFlag('trivial'),
      ruleHeavyFlag('rules'),
      ...prerequisiteChain('chain', 3),
      ...withSegment.flags,
    ],
    segments: withSegment.segments,
  }),
);

function flag(key: string): FlagDefinition {
  const found = snapshot.flags.get(key);
  if (found === undefined) throw new Error(`Fixture flag "${key}" is missing`);
  return found;
}

const trivial = flag('trivial');
const rules = flag('rules');
const chainHead = flag('chain-0');
const beta = flag('beta');
const member = { targetingKey: 'user-99999' };

describe('evaluateFlag', () => {
  bench('trivial flag', () => {
    evaluateFlag(trivial, CONTEXT, snapshot);
  });

  bench('20 rules and a rollout', () => {
    evaluateFlag(rules, CONTEXT, snapshot);
  });

  bench('prerequisites three deep', () => {
    evaluateFlag(chainHead, CONTEXT, snapshot);
  });

  bench('inSegment, 100 000-key segment', () => {
    evaluateFlag(beta, member, snapshot);
  });
});
