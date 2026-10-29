import { describe, expect, it } from 'vitest';

import { parseRuleset, SUPPORTED_SCHEMA_VERSION } from '../../src/index.js';

const flag = {
  key: 'checkout',
  enabled: true,
  variants: { on: true, off: false },
  defaultVariant: 'off',
  offVariant: 'off',
};

describe('parseRuleset document header', () => {
  it('accepts $schema without an issue', () => {
    const result = parseRuleset({ $schema: './ruleset.schema.json', flags: [flag] });

    expect(result.issues).toEqual([]);
    expect(result.flags).toHaveLength(1);
  });

  it.each([undefined, null, 1, SUPPORTED_SCHEMA_VERSION])(
    'reads schemaVersion %s without an issue',
    (schemaVersion) => {
      expect(parseRuleset({ schemaVersion, flags: [flag] }).issues).toEqual([]);
    },
  );

  it('loads a newer document and reports it exactly once', () => {
    const result = parseRuleset({ schemaVersion: SUPPORTED_SCHEMA_VERSION + 1, flags: [flag] });

    expect(result.flags.map((parsed) => parsed.key)).toEqual(['checkout']);
    expect(result.issues).toEqual([
      {
        at: 'schemaVersion',
        message:
          'schemaVersion 2 is newer than 1, the newest this SDK supports. The ruleset is loaded;' +
          ' anything this version cannot read fails closed.',
      },
    ]);
  });

  it.each(['1', 0, -1, 1.5, true])('reports schemaVersion %s and still loads', (schemaVersion) => {
    const result = parseRuleset({ schemaVersion, segments: [], flags: [flag] });

    expect(result.flags).toHaveLength(1);
    expect(result.issues).toEqual([
      { at: 'schemaVersion', message: 'schemaVersion must be a positive integer' },
    ]);
  });
});
