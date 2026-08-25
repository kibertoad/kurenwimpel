/**
 * What a matched rule's result carries in its edge shapes: a rule that can
 * only serve the default, a rule whose split cannot bucket, and the rule id
 * and metadata that must survive onto error results — the exposure feed joins
 * experiments on exactly those fields.
 */

import { describe, expect, it } from 'vitest';

import { evaluateFlag } from '../../src/index.js';
import type { FlagDefinition, TargetingRule } from '../../src/index.js';

const booleanFlag: FlagDefinition<boolean> = {
  key: 'new-checkout',
  enabled: true,
  variants: { on: true, off: false },
  defaultVariant: 'off',
  offVariant: 'off',
};

describe('a matched rule that names neither a variant nor a rollout', () => {
  it('serves the default variant under the rule’s id', () => {
    // Hand-built only — the parser rejects the shape — but the matched rule
    // still decided, so its id has to be on the result.
    const bare = { id: 'bare', conditions: [] } as unknown as TargetingRule;
    const result = evaluateFlag({ ...booleanFlag, rules: [bare] }, { targetingKey: 'user-1' });

    expect(result).toMatchObject({ value: false, variant: 'off', reason: 'STATIC' });
    expect(result.ruleId).toBe('bare');
  });
});

describe('a matched rule whose split cannot bucket', () => {
  it('reports the missing attribute under the rule’s id and still serves the default', () => {
    const flag: FlagDefinition<boolean> = {
      ...booleanFlag,
      rules: [{ id: 'ramp', conditions: [], rollout: [{ variant: 'on', weight: 100 }] }],
    };

    const result = evaluateFlag(flag, {});

    expect(result).toMatchObject({
      value: false,
      variant: 'off',
      reason: 'ERROR',
      errorCode: 'TARGETING_KEY_MISSING',
      ruleId: 'ramp',
    });
    expect(result.errorMessage).toContain('targetingKey');
  });

  it('names the bucketBy attribute the rule’s split actually needed', () => {
    const flag: FlagDefinition<boolean> = {
      ...booleanFlag,
      rules: [
        {
          id: 'ramp',
          conditions: [],
          rollout: { bucketBy: 'accountId', buckets: [{ variant: 'on', weight: 100 }] },
        },
      ],
    };

    const result = evaluateFlag(flag, { targetingKey: 'user-1' });
    expect(result.errorCode).toBe('TARGETING_KEY_MISSING');
    expect(result.errorMessage).toContain('accountId');
    expect(result.ruleId).toBe('ramp');
  });
});

describe('what an error result still carries', () => {
  it('keeps the rule id on a VARIANT_NOT_FOUND raised by that rule', () => {
    // Without the id, the impression for the misconfigured cohort cannot be
    // joined back to the rule that caused it.
    const flag: FlagDefinition<boolean> = {
      ...booleanFlag,
      rules: [{ id: 'oops', conditions: [], variant: 'ghost' }],
    };

    const result = evaluateFlag(flag, { targetingKey: 'user-1' });

    expect(result).toMatchObject({ reason: 'ERROR', errorCode: 'VARIANT_NOT_FOUND' });
    expect(result.ruleId).toBe('oops');
    expect(result.value).toBeUndefined();
  });

  it('keeps the flag metadata on served results and on error results alike', () => {
    const metadata = { team: 'growth' };

    const served = evaluateFlag({ ...booleanFlag, metadata }, { targetingKey: 'user-1' });
    expect(served.metadata).toEqual(metadata);

    const missingVariant = evaluateFlag(
      { ...booleanFlag, metadata, defaultVariant: 'ghost' },
      { targetingKey: 'user-1' },
    );
    expect(missingVariant.errorCode).toBe('VARIANT_NOT_FOUND');
    expect(missingVariant.metadata).toEqual(metadata);

    const invalid = evaluateFlag(
      { ...booleanFlag, metadata, variants: null } as unknown as FlagDefinition,
      { targetingKey: 'user-1' },
    );
    expect(invalid.errorCode).toBe('INVALID_DEFINITION');
    expect(invalid.metadata).toEqual(metadata);
  });

  it('leaves ruleId and metadata off results that had neither', () => {
    // Present-with-undefined is not absent: a result spread onto the OFREP
    // wire must not grow `"ruleId": null`-shaped keys.
    const result = evaluateFlag(booleanFlag, { targetingKey: 'user-1' });
    expect(result).not.toHaveProperty('ruleId');
    expect(result).not.toHaveProperty('metadata');
  });
});
