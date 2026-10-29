/**
 * What hashed key lists cost per evaluation, against the plain lists they
 * replace. ADR 0012 records the numbers this produced.
 */

import { bench, describe } from 'vitest';

import { evaluateFlag, sha256Hex } from '../src/index.js';
import type { FlagDefinition, SegmentDefinition } from '../src/index.js';
import { buildSnapshot } from './build.js';
import { largeSegment, segmentFlag, trivialFlag } from './fixtures.js';

const SEGMENT_SIZE = 100_000;
const plainSegment = largeSegment('plain', SEGMENT_SIZE);
const hashedSegment: SegmentDefinition = {
  key: 'hashed',
  includedHashes: {
    algorithm: 'sha256',
    values: (plainSegment.included ?? []).map((key) => sha256Hex(key)),
  },
};
const targetKeys = Array.from({ length: 1000 }, (_unused, index) => `user-${index * 100}`);

const snapshot = buildSnapshot(
  JSON.stringify({
    flags: [
      segmentFlag('in-plain', 'plain'),
      segmentFlag('in-hashed', 'hashed'),
      { ...trivialFlag('target-plain'), targets: [{ variant: 'off', keys: targetKeys }] },
      {
        ...trivialFlag('target-hashed'),
        targets: [
          {
            variant: 'off',
            keyHashes: { algorithm: 'sha256', values: targetKeys.map((key) => sha256Hex(key)) },
          },
        ],
      },
    ],
    segments: [plainSegment, hashedSegment],
  }),
);

function flag(key: string): FlagDefinition {
  const found = snapshot.flags.get(key);
  if (found === undefined) throw new Error(`Fixture flag "${key}" is missing`);
  return found;
}

const inPlain = flag('in-plain');
const inHashed = flag('in-hashed');
const targetPlain = flag('target-plain');
const targetHashed = flag('target-hashed');

// A fresh key per iteration defeats the one-entry digest memo, which is the
// cost a request with a new targeting key pays.
let counter = 0;
function freshMember(): { targetingKey: string } {
  counter = (counter + 1) % SEGMENT_SIZE;
  return { targetingKey: `user-${counter}` };
}

describe('hashing a targeting key', () => {
  bench('sha256Hex, 10-character key', () => {
    sha256Hex(`user-${(counter = (counter + 1) % SEGMENT_SIZE)}`);
  });

  bench('sha256Hex, 36-character uuid', () => {
    sha256Hex('3f2504e0-4f89-11d3-9a0c-0305e82c3301');
  });
});

describe('inSegment, 100 000-key segment, fresh key per evaluation', () => {
  bench('plain included', () => {
    evaluateFlag(inPlain, freshMember(), snapshot);
  });

  bench('includedHashes', () => {
    evaluateFlag(inHashed, freshMember(), snapshot);
  });
});

describe('individual target, 1 000 keys, fresh key per evaluation', () => {
  bench('plain keys', () => {
    evaluateFlag(targetPlain, freshMember(), snapshot);
  });

  bench('keyHashes', () => {
    evaluateFlag(targetHashed, freshMember(), snapshot);
  });
});

describe('includedHashes, repeated key (digest memo hit)', () => {
  const member = { targetingKey: 'user-99999' };

  bench('includedHashes', () => {
    evaluateFlag(inHashed, member, snapshot);
  });
});
