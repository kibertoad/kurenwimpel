/**
 * Single-flag evaluation bodies: the request, the six shapes a success can take,
 * and the three failure bodies.
 */

import * as z from 'zod/mini';

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
export const evaluationRequestSchema = z.looseObject({ context: evaluationContextSchema });

export type OfrepEvaluationRequest = z.infer<typeof evaluationRequestSchema>;

/** Properties every successful evaluation carries, whatever the flag's type. */
const evaluationSuccessShape = {
  key: flagKeySchema,
  reason: ofrepReasonSchema,
  variant: z.optional(z.string()),
  metadata: z.optional(metadataSchema),
};

/** `components/schemas/booleanFlag`. */
export const booleanEvaluationSchema = z.looseObject({
  ...evaluationSuccessShape,
  value: z.boolean(),
});

/** `components/schemas/stringFlag`. */
export const stringEvaluationSchema = z.looseObject({
  ...evaluationSuccessShape,
  value: z.string(),
});

/** `components/schemas/integerFlag`. */
export const integerEvaluationSchema = z.looseObject({
  ...evaluationSuccessShape,
  value: z.int(),
});

/** `components/schemas/floatFlag`. */
export const floatEvaluationSchema = z.looseObject({
  ...evaluationSuccessShape,
  value: z.number(),
});

/** `components/schemas/objectFlag`. */
export const objectEvaluationSchema = z.looseObject({
  ...evaluationSuccessShape,
  value: jsonObjectSchema,
});

/**
 * `components/schemas/codeDefaultFlag` — the server resolved the flag but is
 * telling the caller to fall back to the default hard-coded at the call site.
 *
 * The distinguishing feature is the *absence* of `value`, which
 * `optional(never())` is what enforces: a missing key passes, any present key
 * fails. Without it this branch would swallow every payload whose `value` did
 * not match one of the typed branches above — `value: null`, say — and report it
 * as a code default.
 */
export const codeDefaultEvaluationSchema = z.looseObject({
  ...evaluationSuccessShape,
  value: z.optional(z.never()),
});

/**
 * `components/schemas/evaluationSuccess` — the `oneOf` over the six flag types.
 *
 * Order is load-bearing between the two numeric branches only: zod returns the
 * first branch that matches, so `integer` must precede `float` for `value: 1` to
 * be reported as an integer. The spec's `oneOf` is strictly speaking violated by
 * whole numbers, which satisfy both `integerFlag` and `floatFlag`; every OFREP
 * implementation has the same ambiguity and both branches infer to `number`.
 */
export const evaluationSuccessSchema = z.union([
  booleanEvaluationSchema,
  stringEvaluationSchema,
  integerEvaluationSchema,
  floatEvaluationSchema,
  objectEvaluationSchema,
  codeDefaultEvaluationSchema,
]);

export type OfrepEvaluationSuccess = z.infer<typeof evaluationSuccessSchema>;

/**
 * `components/schemas/serverEvaluationSuccess` — the 200 body of the single-flag
 * route. The spec declares it as `allOf: [evaluationSuccess]`, so it is the same
 * shape under a name that leaves room for the two to diverge later.
 */
export const serverEvaluationSuccessSchema = evaluationSuccessSchema;

/** `components/schemas/evaluationFailure` — a flag that exists but could not be evaluated. */
export const evaluationFailureSchema = z.looseObject({
  key: flagKeySchema,
  errorCode: ofrepEvaluationErrorCodeSchema,
  errorDetails: z.optional(errorDetailsSchema),
  metadata: z.optional(metadataSchema),
});

export type OfrepEvaluationFailure = z.infer<typeof evaluationFailureSchema>;

/** `components/schemas/flagNotFound` — the key is unknown to the flag management system. */
export const flagNotFoundSchema = z.looseObject({
  key: flagKeySchema,
  errorCode: z.literal(FLAG_NOT_FOUND_ERROR_CODE),
  errorDetails: z.optional(errorDetailsSchema),
  metadata: z.optional(metadataSchema),
});

export type OfrepFlagNotFound = z.infer<typeof flagNotFoundSchema>;

/** `components/schemas/generalErrorResponse` — the 500 body. Every field is optional. */
export const generalErrorResponseSchema = z.looseObject({
  errorDetails: z.optional(errorDetailsSchema),
});

export type OfrepGeneralError = z.infer<typeof generalErrorResponseSchema>;
