import type { InferSchemaOutput } from '@toad-contracts/core';
import { describe, expectTypeOf, it } from 'vitest';
import * as z from 'zod/mini';

import type {
  OfrepBulkEvaluationSuccess,
  OfrepEvaluationFailure,
  OfrepEvaluationSuccess,
  OfrepFlagNotFound,
  OfrepReason,
} from '../src/index.js';
import { evaluateFlagContract } from '../src/index.js';

/**
 * The contract is read by the compiler as much as at runtime, so what it hands a
 * consumer is asserted rather than left implicit. These are checked by
 * `pnpm run typecheck`; at runtime they are no-ops.
 */
describe('inferred types', () => {
  it('reads the path parameter name out of the schema', () => {
    type PathParams = InferSchemaOutput<typeof evaluateFlagContract.requestPathParamsSchema>;
    expectTypeOf<PathParams>().toEqualTypeOf<{ key: string }>();
  });

  it('hands a consumer a typed body rather than an opaque one', () => {
    // `defineApiContract` preserves the literal shape of `responsesByStatusCode`,
    // so a status slot is the concrete schema and not the union of everything a
    // response could be. Lose that — by widening the contract's type, or by
    // reaching for a status the contract does not declare — and every parse
    // through the contract starts yielding `unknown`.
    const parsed = z.safeParse(evaluateFlagContract.responsesByStatusCode[200], {});

    if (parsed.success) {
      expectTypeOf(parsed.data).toEqualTypeOf<OfrepEvaluationSuccess>();
    }
  });

  it('excludes the OpenFeature reasons the protocol has no name for', () => {
    // Also the canary for `OFREP_REASONS` losing its `as const`: without it the
    // type widens to `string` and silently admits all three of these.
    expectTypeOf<'TARGETING_MATCH'>().toExtend<OfrepReason>();
    expectTypeOf<'DEFAULT'>().not.toExtend<OfrepReason>();
    expectTypeOf<'CACHED'>().not.toExtend<OfrepReason>();
    expectTypeOf<'ERROR'>().not.toExtend<OfrepReason>();
  });

  it('makes a flag value narrowable by a plain typeof check', () => {
    const flag = {} as OfrepEvaluationSuccess;

    if ('value' in flag && typeof flag.value === 'boolean') {
      expectTypeOf(flag.value).toEqualTypeOf<boolean>();
    }
  });

  it('admits a failed flag inside a successful bulk response', () => {
    // Partial success is the whole point of the bulk route, and `flagNotFound`
    // is the arm the document's own schema leaves out.
    type Entry = OfrepBulkEvaluationSuccess['flags'][number];
    expectTypeOf<OfrepEvaluationSuccess>().toExtend<Entry>();
    expectTypeOf<OfrepEvaluationFailure>().toExtend<Entry>();
    expectTypeOf<OfrepFlagNotFound>().toExtend<Entry>();
  });
});
