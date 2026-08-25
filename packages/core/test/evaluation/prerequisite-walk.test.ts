/**
 * The two ways a prerequisite walk can be broken rather than merely closed: a
 * chain run deeper than the walk allows, and an edge closing a cycle.
 *
 * Both are properties of the graph, so both have to be reported the same way
 * however the graph is reached — through `evaluate` or through `evaluateAll`,
 * with a memo warmed by earlier flags or with none at all. Anything less makes
 * a flag's answer depend on the order a snapshot happens to iterate in, and the
 * failing answer carries no value, so every SDK falls back to its own hardcoded
 * default rather than to the off variant a gate called for.
 */

import { describe, expect, it } from 'vitest';

import {
  createSharedMemo,
  evaluateFlag,
  FeatureFlagClient,
  StaticProvider,
} from '../../src/index.js';
import type {
  EvaluationEnvironment,
  EvaluationErrorCode,
  EvaluationReason,
  EvaluationResult,
  FlagDefinition,
} from '../../src/index.js';

const flag = (key: string, overrides: Partial<FlagDefinition> = {}): FlagDefinition => ({
  key,
  enabled: true,
  variants: { on: true, off: false },
  defaultVariant: 'on',
  offVariant: 'off',
  ...overrides,
});

/** `f1 → f2 → … → fn`, the last one depending on nothing. */
const chain = (length: number): FlagDefinition[] =>
  Array.from({ length }, (_, index) =>
    flag(
      `f${index + 1}`,
      index + 1 === length ? {} : { prerequisites: [{ flag: `f${index + 2}`, variants: ['on'] }] },
    ),
  );

const environmentOf = (flags: readonly FlagDefinition[]): EvaluationEnvironment => ({
  flags: new Map(flags.map((definition) => [definition.key, definition])),
});

/** The verdict, without the message — what two callers must agree on exactly. */
interface Verdict {
  readonly reason: EvaluationReason;
  readonly errorCode: EvaluationErrorCode | undefined;
}

const summarise = (result: EvaluationResult): Verdict => ({
  reason: result.reason,
  errorCode: result.errorCode,
});

describe('the depth guard counts the same chain however much of it is memoised', () => {
  // A memo hit costs no stack, but it must not cost the guard its count either:
  // `visiting` only grows on the way down, so a dependency answered from the
  // memo used to make the whole chain beneath it vanish from the tally.
  const flags = chain(60);
  const environment = environmentOf(flags);
  const root = flags[0]!;
  const deepest = flags.at(-1)!;

  it('answers a deep chain the same whether the memo is cold or fully warm', () => {
    const cold = evaluateFlag(root, {}, environment);

    // Warmed from the bottom up, so every flag on the chain is already an entry
    // by the time the root asks. This is the order that used to report the very
    // same root as perfectly healthy.
    const warm = createSharedMemo();
    for (const definition of flags.toReversed()) {
      evaluateFlag(definition, {}, environment, warm);
    }

    expect(summarise(cold)).toEqual({ reason: 'ERROR', errorCode: 'INVALID_DEFINITION' });
    expect(summarise(evaluateFlag(root, {}, environment, warm))).toEqual(summarise(cold));
  });

  it('reports the same message, naming the edge the root went in through', () => {
    // Not the flag the guard fired at: a walk that stopped at the limit knows
    // the flag fifty-one levels down, one answering from the memo knows where
    // the chain truly bottoms out, and the two would never agree. The root's
    // own prerequisite is the thread an operator can actually pull, and every
    // frame on the way up rewrites it to its own.
    const warm = createSharedMemo();
    for (const definition of flags.toReversed()) {
      evaluateFlag(definition, {}, environment, warm);
    }

    const cold = evaluateFlag(root, {}, environment).errorMessage;

    expect(cold).toBe('Flag "f1" has a prerequisite chain more than 50 deep through "f2"');
    expect(evaluateFlag(root, {}, environment, warm).errorMessage).toBe(cold);
  });

  it('gives one client the same answer through evaluate and through evaluateAll', async () => {
    // The snapshot iterates in insertion order, so a payload listing its flags
    // deepest-first is all it took to make the two APIs disagree about one flag
    // in one process: `evaluateAll` served it, `getBoolean` fell back.
    const client = new FeatureFlagClient({ provider: new StaticProvider(flags.toReversed()) });
    await client.init();

    const bulk = client.evaluateAll({}).find((result) => result.key === 'f1')!;

    expect(summarise(bulk)).toEqual(summarise(client.evaluate('f1', {})));
    expect(bulk.errorCode).toBe('INVALID_DEFINITION');
    expect(client.getBoolean('f1', false, {})).toBe(false);
  });

  it('still serves a chain that fits, from every root on it', () => {
    // The guard has to stay a limit rather than becoming a ban: 51 flags is 50
    // levels of prerequisite, the deepest walk that is allowed.
    const fits = chain(51);
    const memo = createSharedMemo();

    for (const definition of fits) {
      expect(evaluateFlag(definition, {}, environmentOf(fits), memo).reason).toBe('STATIC');
    }
  });

  it('serves the tail of a chain whose head is too deep', () => {
    // Depth is measured from the flag asked for. f11 roots a chain of 50.
    const memo = createSharedMemo();
    const solo = evaluateFlag(flags[10]!, {}, environment);

    expect(evaluateFlag(root, {}, environment, memo).errorCode).toBe('INVALID_DEFINITION');
    expect(summarise(evaluateFlag(flags[10]!, {}, environment, memo))).toEqual(summarise(solo));
    expect(solo.reason).toBe('STATIC');
    expect(evaluateFlag(deepest, {}, environment, memo).reason).toBe('STATIC');
  });
});

describe('a cycle is diagnosed against the flag that was asked for', () => {
  const a = flag('a', { prerequisites: [{ flag: 'b', variants: ['on'] }] });
  const b = flag('b', { prerequisites: [{ flag: 'a', variants: ['on'] }] });
  const outside = flag('outside', { prerequisites: [{ flag: 'a', variants: ['on'] }] });
  const environment = environmentOf([a, b, outside]);

  it('reports every flag that depends on one, whichever order they are walked in', () => {
    for (const order of [
      [a, b, outside],
      [outside, b, a],
    ]) {
      const memo = createSharedMemo();
      for (const subject of order) {
        expect(summarise(evaluateFlag(subject, {}, environment, memo))).toEqual({
          reason: 'ERROR',
          errorCode: 'INVALID_DEFINITION',
        });
      }
    }
  });

  it('names the flag asked for, not whichever one an earlier walk happened to enter at', () => {
    // The message used to be memoised under the flag the first walk noticed the
    // cycle at and then answered for every later dependent, so a bulk response
    // could tell two flags about a cycle neither of them is on.
    const memo = createSharedMemo();
    evaluateFlag(a, {}, environment, memo);

    const solo = evaluateFlag(outside, {}, environment);
    const shared = evaluateFlag(outside, {}, environment, memo);

    expect(shared).toEqual(solo);
    expect(solo.key).toBe('outside');
    expect(solo.errorMessage).toContain('Flag "outside" has a prerequisite cycle');
  });

  it('reports a self-referential flag the same way', () => {
    const selfish = flag('selfish', { prerequisites: [{ flag: 'selfish', variants: ['on'] }] });
    const result = evaluateFlag(selfish, {}, environmentOf([selfish]));

    expect(result.errorCode).toBe('INVALID_DEFINITION');
    expect(result.errorMessage).toContain('"selfish" requires "selfish"');
  });

  it('leaves a diamond that merely shares a dependency alone', () => {
    // Two paths to one flag is not a cycle, and the memo is what keeps it from
    // costing two walks.
    const shared = flag('shared');
    const left = flag('left', { prerequisites: [{ flag: 'shared', variants: ['on'] }] });
    const right = flag('right', { prerequisites: [{ flag: 'shared', variants: ['on'] }] });
    const top = flag('top', {
      prerequisites: [
        { flag: 'left', variants: ['on'] },
        { flag: 'right', variants: ['on'] },
      ],
    });

    expect(evaluateFlag(top, {}, environmentOf([top, left, right, shared])).reason).toBe('STATIC');
  });
});
