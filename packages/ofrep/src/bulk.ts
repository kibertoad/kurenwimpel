/**
 * Bulk evaluation bodies: one request carrying a static context, one response
 * carrying every flag the caller is entitled to see.
 */

import * as z from 'zod/mini';

import { errorDetailsSchema, evaluationContextSchema, metadataSchema } from './common.js';
import {
  evaluationFailureSchema,
  evaluationSuccessSchema,
  flagNotFoundSchema,
} from './evaluation.js';
import { eventStreamSchema } from './event-stream.js';

/** `components/schemas/bulkEvaluationRequest`. */
export const bulkEvaluationRequestSchema = z.looseObject({ context: evaluationContextSchema });

export type OfrepBulkEvaluationRequest = z.infer<typeof bulkEvaluationRequestSchema>;

/**
 * One entry of the `flags` array: a per-flag success, a per-flag failure, or an
 * unknown key.
 *
 * The three are told apart structurally — a success requires `reason`, the two
 * failures require `errorCode`, and their error codes are disjoint — so no
 * ordering assumption is needed.
 *
 * `flagNotFound` is admitted here even though OFREP 0.3.0 lists the array's
 * items as `oneOf: [evaluationSuccess, evaluationFailure]`. That is a defect in
 * the specification: `FLAG_NOT_FOUND` is absent from `evaluationFailure`'s error
 * codes, yet the document's own bulk example returns an entry carrying it, so
 * the two cannot both be honoured. Accepting the third arm keeps the contract
 * agreeing with the example a server implementer will have copied.
 */
export const bulkEvaluationEntrySchema = z.union([
  evaluationSuccessSchema,
  evaluationFailureSchema,
  flagNotFoundSchema,
]);

export type OfrepBulkEvaluationEntry = z.infer<typeof bulkEvaluationEntrySchema>;

/**
 * `components/schemas/bulkEvaluationSuccess`.
 *
 * A 200 does not mean every flag evaluated: individual flags fail inside `flags`
 * while the request as a whole succeeds. Only a request-level failure — an
 * unparseable context, say — gets a 400 and a {@link bulkEvaluationFailureSchema}.
 */
export const bulkEvaluationSuccessSchema = z.looseObject({
  flags: z.array(bulkEvaluationEntrySchema),
  metadata: z.optional(metadataSchema),
  eventStreams: z.optional(z.array(eventStreamSchema)),
});

export type OfrepBulkEvaluationSuccess = z.infer<typeof bulkEvaluationSuccessSchema>;

/**
 * `components/schemas/bulkEvaluationFailure`.
 *
 * `errorCode` is an open `string` here, unlike the single-flag failure body: the
 * spec points at the OpenFeature error-code list without enumerating it, so the
 * contract does not close a set the protocol left open.
 */
export const bulkEvaluationFailureSchema = z.looseObject({
  errorCode: z.string(),
  errorDetails: z.optional(errorDetailsSchema),
});

export type OfrepBulkEvaluationFailure = z.infer<typeof bulkEvaluationFailureSchema>;
