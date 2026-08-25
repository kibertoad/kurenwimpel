/**
 * The bookkeeping of the prerequisite walk, at its edges: what an empty list
 * costs, what the failure messages say exactly, and the depth a memo hit is
 * charged. `prerequisites.test.ts` proves the gate's decisions; this file
 * proves the accounting that keeps those decisions identical between a cold
 * walk and a memoised one.
 */

import { describe, expect, it } from 'vitest';

import { createSharedMemo, evaluateFlag } from '../../src/index.js';
import type {
  EvaluationEnvironment,
  FlagDefinition,
  SharedPrerequisiteMemo,
} from '../../src/index.js';

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

/** A linear chain c0 → c1 → … of `length` flags; only the last has no prerequisite. */
const chain = (length: number): FlagDefinition[] =>
  Array.from({ length }, (_, index) =>
    flag(
      `c${index}`,
      index === length - 1 ? {} : { prerequisites: [{ flag: `c${index + 1}`, variants: ['on'] }] },
    ),
  );

describe('an empty prerequisite list', () => {
  it('gates nothing and costs nothing', () => {
    const ungated = flag('ungated', { prerequisites: [] });
    // No environment either: an empty list must not go looking for one.
    expect(evaluateFlag(ungated, { targetingKey: 'u1' })).toMatchObject({
      value: true,
      reason: 'STATIC',
    });
  });
});

describe('what the walk failures say, exactly', () => {
  it('names the edge that closed a cycle, and nothing else', () => {
    // The depth failure appends the edge the walk went in through; a cycle
    // message already names its edge and must not grow a second one.
    const a = flag('a', { prerequisites: [{ flag: 'b', variants: ['on'] }] });
    const b = flag('b', { prerequisites: [{ flag: 'a', variants: ['on'] }] });

    expect(evaluateFlag(a, {}, environmentOf(a, b)).errorMessage).toBe(
      'Flag "a" has a prerequisite cycle: "b" requires "a"',
    );

    const selfish = flag('selfish', { prerequisites: [{ flag: 'selfish', variants: ['on'] }] });
    expect(evaluateFlag(selfish, {}, environmentOf(selfish)).errorMessage).toBe(
      'Flag "selfish" has a prerequisite cycle: "selfish" requires "selfish"',
    );
  });
});

describe('a memo hit is charged the depth of the subtree it skips', () => {
  it('trips the depth guard through a memoised chain exactly as through a cold one', () => {
    // 51 flags: the deepest chain a walk accepts. Evaluating c0 warms the memo
    // with every flag below it and how deep each one's subtree ran.
    const flags = chain(51);
    const environment = environmentOf(...flags);
    const memo = createSharedMemo();

    expect(evaluateFlag(flags[0]!, {}, environment, memo).reason).toBe('STATIC');

    // One more flag on top pushes the same chain past the limit. The walk
    // answers c1 from the memo now — and the hit must still count the fifty
    // levels below it, or the verdict would depend on who walked first.
    const root = flag('root', { prerequisites: [{ flag: 'c0', variants: ['on'] }] });
    const result = evaluateFlag(root, {}, environmentOf(root, ...flags), memo);

    expect(result).toMatchObject({ reason: 'ERROR', errorCode: 'INVALID_DEFINITION' });
    expect(result.errorMessage).toContain('more than 50 deep');
  });
});

describe('a dependency the memo knows to be structurally broken', () => {
  it('is reported as invalid, not disguised as an ordinary failed prerequisite', () => {
    // Only a hand-filled memo can carry this in, but the distinction it
    // preserves is real: "your graph is broken" and "your dependency said no"
    // send an operator to different places.
    const memo: SharedPrerequisiteMemo = createSharedMemo();
    memo.set('dep', {
      result: {
        key: 'dep',
        value: undefined,
        variant: undefined,
        reason: 'ERROR',
        errorCode: 'INVALID_DEFINITION',
        errorMessage: 'Flag "dep" is not a usable definition: broken',
      },
      depth: 0,
    });

    const gated = flag('gated', { prerequisites: [{ flag: 'dep', variants: ['on'] }] });
    const result = evaluateFlag(gated, {}, environmentOf(gated, flag('dep')), memo);

    expect(result).toMatchObject({ reason: 'ERROR', errorCode: 'INVALID_DEFINITION' });
    expect(result.errorMessage).toContain('broken');
  });
});
