/**
 * Single-flag evaluation bodies: the request, the six shapes a success can take,
 * and the three failure bodies.
 */

import type { InferOutput } from 'valibot';
import {
  boolean,
  integer,
  literal,
  looseObject,
  never,
  number,
  optional,
  pipe,
  string,
  union,
} from 'valibot';

import {
  errorDetailsSchema,
  evaluationContextSchema,
  flagKeySchema,
  FLAG_NOT_FOUND_ERROR_CODE,
  jsonObjectSchema,
  metadataSchema,
  ofrepEvaluationErrorCodeSchema,
  ofrepReasonSchema,
} from './common.js';

/** `components/schemas/evaluationRequest`. */
export const evaluationRequestSchema = looseObject({ context: evaluationContextSchema });

export type OfrepEvaluationRequest = InferOutput<typeof evaluationRequestSchema>;

/** Properties every successful evaluation carries, whatever the flag's type. */
const evaluationSuccessEntries = {
  key: flagKeySchema,
  reason: ofrepReasonSchema,
  variant: optional(string()),
  metadata: optional(metadataSchema),
};

/** `components/schemas/booleanFlag`. */
export const booleanEvaluationSchema = looseObject({
  ...evaluationSuccessEntries,
  value: boolean(),
});

/** `components/schemas/stringFlag`. */
export const stringEvaluationSchema = looseObject({ ...evaluationSuccessEntries, value: string() });

/** `components/schemas/integerFlag`. */
export const integerEvaluationSchema = looseObject({
  ...evaluationSuccessEntries,
  value: pipe(number(), integer()),
});

/** `components/schemas/floatFlag`. */
export const floatEvaluationSchema = looseObject({ ...evaluationSuccessEntries, value: number() });

/** `components/schemas/objectFlag`. */
export const objectEvaluationSchema = looseObject({
  ...evaluationSuccessEntries,
  value: jsonObjectSchema,
});

/**
 * `components/schemas/codeDefaultFlag` — the server resolved the flag but is
 * telling the caller to fall back to the default hard-coded at the call site.
 *
 * The distinguishing feature is the *absence* of `value`, which `optional(never())`
 * is what enforces: a missing key passes, any present key fails. Without it this
 * branch would swallow every payload whose `value` did not match one of the typed
 * branches above — `value: null`, say — and report it as a code default.
 */
export const codeDefaultEvaluationSchema = looseObject({
  ...evaluationSuccessEntries,
  value: optional(never()),
});

/**
 * `components/schemas/evaluationSuccess` — the `oneOf` over the six flag types.
 *
 * Order is load-bearing between the two numeric branches only: valibot returns
 * the first branch that matches, so `integer` must precede `float` for `value: 1`
 * to be reported as an integer. The spec's `oneOf` is strictly speaking violated
 * by whole numbers, which satisfy both `integerFlag` and `floatFlag`; every OFREP
 * implementation has the same ambiguity and both branches infer to `number`.
 */
export const evaluationSuccessSchema = union([
  booleanEvaluationSchema,
  stringEvaluationSchema,
  integerEvaluationSchema,
  floatEvaluationSchema,
  objectEvaluationSchema,
  codeDefaultEvaluationSchema,
]);

export type OfrepEvaluationSuccess = InferOutput<typeof evaluationSuccessSchema>;

/**
 * `components/schemas/serverEvaluationSuccess` — the 200 body of the single-flag
 * route. The spec declares it as `allOf: [evaluationSuccess]`, so it is the same
 * shape under a name that leaves room for the two to diverge later.
 */
export const serverEvaluationSuccessSchema = evaluationSuccessSchema;

/** `components/schemas/evaluationFailure` — a flag that exists but could not be evaluated. */
export const evaluationFailureSchema = looseObject({
  key: flagKeySchema,
  errorCode: ofrepEvaluationErrorCodeSchema,
  errorDetails: optional(errorDetailsSchema),
  metadata: optional(metadataSchema),
});

export type OfrepEvaluationFailure = InferOutput<typeof evaluationFailureSchema>;

/** `components/schemas/flagNotFound` — the key is unknown to the flag management system. */
export const flagNotFoundSchema = looseObject({
  key: flagKeySchema,
  errorCode: literal(FLAG_NOT_FOUND_ERROR_CODE),
  errorDetails: optional(errorDetailsSchema),
  metadata: optional(metadataSchema),
});

export type OfrepFlagNotFound = InferOutput<typeof flagNotFoundSchema>;

/** `components/schemas/generalErrorResponse` — the 500 body. Every field is optional. */
export const generalErrorResponseSchema = looseObject({
  errorDetails: optional(errorDetailsSchema),
});

export type OfrepGeneralError = InferOutput<typeof generalErrorResponseSchema>;
