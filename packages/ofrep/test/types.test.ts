import type { InferSchemaOutput } from '@toad-contracts/core';
import type { InferOutput } from 'valibot';
import { describe, expectTypeOf, it } from 'vitest';

import type {
  OfrepBulkEvaluationSuccess,
  OfrepEvaluationSuccess,
  OfrepReason,
} from '../src/index.js';
import type { evaluateFlagContract, evaluateFlagsBulkContract } from '../src/index.js';

/**
 * The contract is meant to be read by the compiler as much as at runtime, so the
 * types it hands a consumer are asserted here rather than left implicit. These
 * are checked by `pnpm run typecheck`; at runtime they are no-ops.
 */
describe('inferred types', () => {
  it('types the single-flag path parameters from the contract', () => {
    type PathParams = InferSchemaOutput<typeof evaluateFlagContract.requestPathParamsSchema>;
    expectTypeOf<PathParams>().toEqualTypeOf<{ key: string }>();
  });

  it('narrows the reason to the protocol enum', () => {
    expectTypeOf<OfrepReason>().toEqualTypeOf<
      'STATIC' | 'TARGETING_MATCH' | 'SPLIT' | 'DISABLED' | 'UNKNOWN'
    >();
  });

  it('types a 200 as the union of the six flag shapes', () => {
    type Ok = InferOutput<(typeof evaluateFlagContract.responsesByStatusCode)[200]>;
    expectTypeOf<Ok>().toEqualTypeOf<OfrepEvaluationSuccess>();
  });

  it('makes a flag value narrowable by a plain typeof check', () => {
    const flag = {} as OfrepEvaluationSuccess;
    if ('value' in flag && typeof flag.value === 'boolean') {
      expectTypeOf(flag.value).toEqualTypeOf<boolean>();
    }
  });

  it('types the bulk 200 as a flag array', () => {
    type Bulk = InferOutput<(typeof evaluateFlagsBulkContract.responsesByStatusCode)[200]>;
    expectTypeOf<Bulk>().toEqualTypeOf<OfrepBulkEvaluationSuccess>();
    expectTypeOf<Bulk['flags']>().toBeArray();
  });
});
