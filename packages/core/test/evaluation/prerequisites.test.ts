import { describe, expect, it } from 'vitest';

import { evaluateFlag } from '../../src/index.js';
import type { EvaluationEnvironment, FlagDefinition } from '../../src/index.js';

const flag = (key: string, overrides: Partial<FlagDefinition> = {}): FlagDefinition => ({
  key,
  enabled: true,
  variants: { on: true, off: false },
  defaultVariant: 'on',
  offVariant: 'off',
  ...overrides,
});

const environmentOf = (...flags: FlagDefinition[]): EvaluationEnvironment => ({
  flags: new Map(flags.map((definition) => [definition.key, definition])),
});

describe('prerequisites', () => {
  const dependent = flag('checkout-redesign', {
    prerequisites: [{ flag: 'new-backend', variants: ['on'] }],
  });

  it('proceeds when the prerequisite serves a listed variant', () => {
    const environment = environmentOf(dependent, flag('new-backend'));
    const result = evaluateFlag(dependent, { targetingKey: 'u1' }, environment);

    expect(result).toMatchObject({ value: true, variant: 'on', reason: 'STATIC' });
  });

  it('serves the off variant when the prerequisite serves another variant', () => {
    const environment = environmentOf(dependent, flag('new-backend', { defaultVariant: 'off' }));
    const result = evaluateFlag(dependent, { targetingKey: 'u1' }, environment);

    expect(result).toMatchObject({
      value: false,
      variant: 'off',
      reason: 'PREREQUISITE_FAILED',
      failedPrerequisite: 'new-backend',
    });
  });

  it('fails when the prerequisite is disabled, even if its off variant is listed', () => {
    const gated = flag('gated', { prerequisites: [{ flag: 'dep', variants: ['off'] }] });
    const environment = environmentOf(gated, flag('dep', { enabled: false }));

    expect(evaluateFlag(gated, {}, environment).reason).toBe('PREREQUISITE_FAILED');
  });

  it('fails when the prerequisite flag is missing, or no environment was given', () => {
    expect(evaluateFlag(dependent, {}, environmentOf(dependent)).reason).toBe(
      'PREREQUISITE_FAILED',
    );
    expect(evaluateFlag(dependent, {}).reason).toBe('PREREQUISITE_FAILED');
  });

  it('evaluates the prerequisite with the same context', () => {
    const gate = flag('gate', {
      defaultVariant: 'off',
      rules: [
        {
          id: 'eu-only',
          conditions: [{ attribute: 'region', operator: 'eq', value: 'eu' }],
          variant: 'on',
        },
      ],
    });
    const gated = flag('gated', { prerequisites: [{ flag: 'gate', variants: ['on'] }] });
    const environment = environmentOf(gate, gated);

    expect(evaluateFlag(gated, { region: 'eu' }, environment).reason).toBe('STATIC');
    expect(evaluateFlag(gated, { region: 'us' }, environment).reason).toBe('PREREQUISITE_FAILED');
  });

  it('accepts any of several listed variants', () => {
    const gated = flag('gated', { prerequisites: [{ flag: 'dep', variants: ['on', 'canary'] }] });
    const dep = flag('dep', {
      variants: { on: true, off: false, canary: true },
      defaultVariant: 'canary',
    });

    expect(evaluateFlag(gated, {}, environmentOf(gated, dep)).reason).toBe('STATIC');
  });

  it('follows chains of prerequisites', () => {
    const a = flag('a', { prerequisites: [{ flag: 'b', variants: ['on'] }] });
    const b = flag('b', { prerequisites: [{ flag: 'c', variants: ['on'] }] });
    const c = flag('c', { defaultVariant: 'off' });

    const environment = environmentOf(a, b, c);
    const result = evaluateFlag(a, {}, environment);

    // c serves off, so b fails, so b serves off, so a fails.
    expect(result).toMatchObject({ reason: 'PREREQUISITE_FAILED', failedPrerequisite: 'b' });

    const healthy = environmentOf(a, b, flag('c'));
    expect(evaluateFlag(a, {}, healthy).reason).toBe('STATIC');
  });

  it('reports a cycle as an invalid definition instead of recursing forever', () => {
    const a = flag('a', { prerequisites: [{ flag: 'b', variants: ['on'] }] });
    const b = flag('b', { prerequisites: [{ flag: 'a', variants: ['on'] }] });

    const result = evaluateFlag(a, {}, environmentOf(a, b));

    expect(result).toMatchObject({ reason: 'ERROR', errorCode: 'INVALID_DEFINITION' });
    expect(result.errorMessage).toContain('cycle');
  });

  it('reports a self-referential flag as a cycle', () => {
    const selfish = flag('selfish', { prerequisites: [{ flag: 'selfish', variants: ['on'] }] });

    expect(evaluateFlag(selfish, {}, environmentOf(selfish)).errorCode).toBe('INVALID_DEFINITION');
  });

  it('fails when the dependency errors, instead of trusting its fallback variant', () => {
    // Without a targeting key the dependency cannot bucket; it serves its
    // defaultVariant with an error. That fallback vouches for nothing — the
    // gate must not open exactly for the contexts where evaluation failed.
    const dep = flag('dep', {
      defaultVariant: 'on',
      rollout: [{ variant: 'off', weight: 100 }],
    });
    const gated = flag('gated', { prerequisites: [{ flag: 'dep', variants: ['on'] }] });
    const environment = environmentOf(gated, dep);

    expect(evaluateFlag(gated, {}, environment).reason).toBe('PREREQUISITE_FAILED');
    // With a key the dependency actually serves 'off', which also fails.
    expect(evaluateFlag(gated, { targetingKey: 'u1' }, environment).reason).toBe(
      'PREREQUISITE_FAILED',
    );
  });

  it('gates before individual targets: a failed prerequisite beats a target', () => {
    const gated = flag('gated', {
      prerequisites: [{ flag: 'missing', variants: ['on'] }],
      targets: [{ variant: 'on', keys: ['qa'] }],
    });

    expect(evaluateFlag(gated, { targetingKey: 'qa' }, environmentOf(gated)).reason).toBe(
      'PREREQUISITE_FAILED',
    );
  });
});

describe('prerequisite graph cost', () => {
  /** Counts the lookups a walk makes, which is what runs away when it re-walks. */
  class CountingFlags extends Map<string, FlagDefinition> {
    lookups = 0;

    override get(key: string): FlagDefinition | undefined {
      this.lookups += 1;
      return super.get(key);
    }
  }

  const chain = (depth: number, edgesPerLevel: number): FlagDefinition[] =>
    Array.from({ length: depth }, (_, index) =>
      flag(
        `f${index}`,
        index === depth - 1
          ? {}
          : {
              prerequisites: Array.from({ length: edgesPerLevel }, () => ({
                flag: `f${index + 1}`,
                variants: ['on'],
              })),
            },
      ),
    );

  it('evaluates each dependency once per request, not once per path to it', () => {
    // Every level naming the next one twice is a diamond at every level: one
    // evaluation per flag is linear, one per path is 2^depth. The parser
    // rejects the duplicate edge now, but a hand-built graph can still ask.
    const flags = new CountingFlags(chain(25, 2).map((definition) => [definition.key, definition]));
    const root = flags.get('f0')!;
    flags.lookups = 0;

    expect(evaluateFlag(root, {}, { flags }).reason).toBe('STATIC');
    // Two edges per level, each a lookup; everything past the first is a memo hit.
    expect(flags.lookups).toBeLessThan(100);
  });

  it('calls a graph deeper than the walk allows an invalid definition', () => {
    const flags = new Map(chain(60, 1).map((definition) => [definition.key, definition]));
    const result = evaluateFlag(flags.get('f0')!, {}, { flags });

    expect(result).toMatchObject({ reason: 'ERROR', errorCode: 'INVALID_DEFINITION' });
    expect(result.errorMessage).toContain('prerequisites deep');
  });
});
