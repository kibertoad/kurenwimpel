import { describe, expect, it } from 'vitest';

import { buildTargetIndex, evaluateFlag } from '../../src/index.js';
import type { EvaluationContext, FlagDefinition } from '../../src/index.js';

const booleanFlag: FlagDefinition<boolean> = {
  key: 'new-checkout',
  enabled: true,
  variants: { on: true, off: false },
  defaultVariant: 'off',
  offVariant: 'off',
};

describe('evaluateFlag pipeline', () => {
  it('serves the off variant when disabled, ignoring everything else', () => {
    const result = evaluateFlag(
      {
        ...booleanFlag,
        enabled: false,
        targets: [{ variant: 'on', keys: ['user-1'] }],
        rules: [{ id: 'always', conditions: [], variant: 'on' }],
      },
      { targetingKey: 'user-1' },
    );

    expect(result).toMatchObject({ value: false, variant: 'off', reason: 'DISABLED' });
  });

  it('serves the default variant with STATIC when nothing matches', () => {
    const result = evaluateFlag(booleanFlag, { targetingKey: 'user-1' });
    expect(result).toMatchObject({ value: false, variant: 'off', reason: 'STATIC' });
  });

  it('serves an individually targeted key before any rule', () => {
    const result = evaluateFlag(
      {
        ...booleanFlag,
        targets: [{ variant: 'on', keys: ['qa-account'] }],
        rules: [{ id: 'nobody', conditions: [], variant: 'off' }],
      },
      { targetingKey: 'qa-account' },
    );

    expect(result).toMatchObject({ value: true, variant: 'on', reason: 'TARGETING_MATCH' });
    expect(result.ruleId).toBeUndefined();
  });

  it('serves the first matching rule and reports its id', () => {
    const result = evaluateFlag(
      {
        ...booleanFlag,
        rules: [
          {
            id: 'internal-staff',
            conditions: [{ attribute: 'email', operator: 'endsWith', value: '@lokalise.com' }],
            variant: 'on',
          },
          { id: 'second', conditions: [], variant: 'off' },
        ],
      },
      { targetingKey: 'user-1', email: 'dev@lokalise.com' },
    );

    expect(result).toMatchObject({
      value: true,
      variant: 'on',
      reason: 'TARGETING_MATCH',
      ruleId: 'internal-staff',
    });
  });

  it('treats an empty condition list as an unconditional match', () => {
    const result = evaluateFlag(
      { ...booleanFlag, rules: [{ id: 'all', conditions: [], variant: 'on' }] },
      {},
    );
    expect(result).toMatchObject({ value: true, reason: 'TARGETING_MATCH' });
  });

  it('requires every condition of a rule to hold', () => {
    const flag: FlagDefinition<boolean> = {
      ...booleanFlag,
      rules: [
        {
          id: 'paid-eu',
          conditions: [
            { attribute: 'plan', operator: 'in', value: ['pro', 'enterprise'] },
            { attribute: 'region', operator: 'eq', value: 'eu' },
          ],
          variant: 'on',
        },
      ],
    };

    expect(evaluateFlag(flag, { plan: 'pro', region: 'eu' }).value).toBe(true);
    expect(evaluateFlag(flag, { plan: 'pro', region: 'us' }).value).toBe(false);
  });

  it('errors instead of throwing when a variant is missing', () => {
    const result = evaluateFlag(
      {
        ...booleanFlag,
        rules: [{ id: 'r', conditions: [], variant: 'on' }],
        variants: { off: false },
      },
      {},
    );

    expect(result).toMatchObject({
      value: undefined,
      reason: 'ERROR',
      errorCode: 'VARIANT_NOT_FOUND',
    });
  });

  it('never serves a variant resolved through the prototype chain', () => {
    // A hand-built flag naming a variant 'constructor' must be
    // VARIANT_NOT_FOUND, not Object.prototype.constructor served as a value.
    const result = evaluateFlag({ ...booleanFlag, defaultVariant: 'constructor' });

    expect(result).toMatchObject({
      value: undefined,
      reason: 'ERROR',
      errorCode: 'VARIANT_NOT_FOUND',
    });
  });

  it('passes flag metadata through to the result', () => {
    const result = evaluateFlag({ ...booleanFlag, metadata: { experiment: 'checkout-q3' } }, {});
    expect(result.metadata).toEqual({ experiment: 'checkout-q3' });
  });
});

describe('individual targets', () => {
  const targeted: FlagDefinition<boolean> = {
    ...booleanFlag,
    targets: [
      { variant: 'on', keys: ['qa-1', 'qa-2'] },
      { variant: 'off', keys: ['banned'] },
    ],
  };

  it('resolves through a compiled index when the environment carries one', () => {
    const targetIndex = buildTargetIndex([targeted]);

    expect(evaluateFlag(targeted, { targetingKey: 'qa-2' }, { targetIndex })).toMatchObject({
      value: true,
      reason: 'TARGETING_MATCH',
    });
    expect(evaluateFlag(targeted, { targetingKey: 'nobody' }, { targetIndex }).reason).toBe(
      'STATIC',
    );
  });

  it('agrees with the uncompiled scan, so an index only changes the cost', () => {
    const targetIndex = buildTargetIndex([targeted]);

    for (const key of ['qa-1', 'qa-2', 'banned', 'someone-else', '']) {
      expect(evaluateFlag(targeted, { targetingKey: key }, { targetIndex })).toEqual(
        evaluateFlag(targeted, { targetingKey: key }),
      );
    }
  });

  it('pins a targeting key that arrived as a number', () => {
    // A context takes any JSON, and `targetingKey: user.id` off a numeric
    // column is the ordinary case. Splits always bucketed it; targets and
    // segment lists did not, so the pinned QA account was silently not pinned
    // and an excluded subject was served the treatment anyway.
    const numeric: FlagDefinition<boolean> = {
      ...booleanFlag,
      targets: [{ variant: 'on', keys: ['12345'] }],
    };
    const context = { targetingKey: 12_345 } as unknown as EvaluationContext;

    expect(evaluateFlag(numeric, context)).toMatchObject({
      value: true,
      variant: 'on',
      reason: 'TARGETING_MATCH',
    });
    expect(evaluateFlag(numeric, context, { targetIndex: buildTargetIndex([numeric]) })).toEqual(
      evaluateFlag(numeric, context),
    );
  });
});

describe('definitions the parser would have rejected', () => {
  // Nothing here can arrive through parseFlagDefinition. It arrives when a
  // caller casts JSON.parse output to FlagDefinition, and the promise this
  // module makes is that it degrades to a result rather than a thrown TypeError
  // on a request path.
  const handBuilt = (overrides: Record<string, unknown>): FlagDefinition<boolean> => ({
    ...booleanFlag,
    ...overrides,
  });

  it('errors on a split object carrying no buckets', () => {
    const result = evaluateFlag(handBuilt({ rollout: { bucketBy: 'accountId' } }), {
      targetingKey: 'user-1',
      accountId: 'acme',
    });

    expect(result).toMatchObject({ reason: 'STATIC', variant: 'off' });
  });

  it('skips a rule with no condition list instead of matching everyone', () => {
    const result = evaluateFlag(handBuilt({ rules: [{ id: 'broken', variant: 'on' }] }), {
      targetingKey: 'user-1',
    });

    expect(result).toMatchObject({ value: false, variant: 'off', reason: 'STATIC' });
  });

  it('targets nobody through a keys field that is not a list', () => {
    // A bare string would otherwise match every substring of itself, and would
    // disagree with the compiled index, which iterates it as characters.
    const flag = handBuilt({ targets: [{ variant: 'on', keys: 'qa-1' }] });
    const targetIndex = buildTargetIndex([flag]);

    expect(evaluateFlag(flag, { targetingKey: 'qa-1' }).reason).toBe('STATIC');
    expect(evaluateFlag(flag, { targetingKey: 'qa-1' }, { targetIndex }).reason).toBe('STATIC');
  });

  it('reports a shape it cannot walk at all as an invalid definition', () => {
    // `rules` as an object rather than a list is not iterable, so the walk
    // itself throws where every other guard here is a value check.
    const result = evaluateFlag(handBuilt({ rules: { id: 'broken', variant: 'on' } }), {
      targetingKey: 'user-1',
    });

    expect(result).toMatchObject({ reason: 'ERROR', errorCode: 'INVALID_DEFINITION' });
    expect(result.errorMessage).toContain('not a usable definition');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a bare key', 'new-checkout'],
    ['an object with no key', { enabled: true }],
  ])('reports %s as not a definition rather than throwing', (_label, notAFlag) => {
    // The catch that implements the no-throw contract names the flag in the
    // message it builds, so it cannot also be what handles a flag with no name
    // — it dereferenced the very thing that was missing.
    const result = evaluateFlag(notAFlag as unknown as FlagDefinition, { targetingKey: 'u1' });

    expect(result).toMatchObject({ reason: 'ERROR', errorCode: 'INVALID_DEFINITION' });
    expect(result.errorMessage).toContain('Not a flag definition');
  });

  it('reads a null context as an empty one, not as a broken flag', () => {
    // An explicit null skips the parameter default. Reporting it as an invalid
    // definition sends whoever reads the error after the wrong thing entirely.
    const result = evaluateFlag(booleanFlag, null as unknown as EvaluationContext);

    expect(result).toMatchObject({ value: false, variant: 'off', reason: 'STATIC' });
  });
});
