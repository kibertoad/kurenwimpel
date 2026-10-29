import { describe, expect, it } from 'vitest';

import { FLAG_KINDS, parseRuleset, SUPPORTED_SCHEMA_VERSION } from '../../src/index.js';
import { accepted, conditionByOperator } from './accepted-fixtures.js';
import { rejected } from './rejected-fixtures.js';
import { schema, schemaErrors } from './validate.js';

describe('ruleset.schema.json', () => {
  it.each(Object.entries(accepted))('accepts what the parser accepts: %s', (_, document) => {
    expect(parseRuleset(document).issues).toEqual([]);
    expect(schemaErrors(document)).toEqual([]);
  });

  it.each(Object.entries(rejected))('rejects what the parser reports: %s', (_, document) => {
    expect(parseRuleset(document).issues).not.toEqual([]);
    expect(schemaErrors(document)).not.toEqual([]);
  });

  it('lists exactly the operators the engine knows', () => {
    const operators = schema.$defs.condition.properties.operator.enum;
    expect(operators.toSorted()).toEqual(Object.keys(conditionByOperator).toSorted());
  });

  it('lists exactly the lifecycle kinds the parser knows', () => {
    const kinds = schema.$defs.lifecycle.properties.kind.anyOf[1]?.enum;
    expect(kinds).toEqual(FLAG_KINDS);
  });

  it('caps schemaVersion at the version this engine supports', () => {
    expect(schema.$defs.document.properties.schemaVersion.maximum).toBe(SUPPORTED_SCHEMA_VERSION);
  });
});
