/**
 * Bulk evaluation bodies: one request carrying a static context, one response
 * carrying every flag the caller is entitled to see.
 */

import type { InferOutput } from 'valibot';
import { array, looseObject, optional, string, union } from 'valibot';

import { errorDetailsSchema, evaluationContextSchema, metadataSchema } from './common.js';
import {
  evaluationFailureSchema,
  evaluationSuccessSchema,
  flagNotFoundSchema,
} from './evaluation.js';
import { eventStreamSchema } from './event-stream.js';

/** `components/schemas/bulkEvaluationRequest`. */
export const bulkEvaluationRequestSchema = looseObject({ context: evaluationContextSchema });

export type OfrepBulkEvaluationRequest = InferOutput<typeof bulkEvaluationRequestSchema>;

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
export const bulkEvaluationEntrySchema = union([
  evaluationSuccessSchema,
  evaluationFailureSchema,
  flagNotFoundSchema,
]);

export type OfrepBulkEvaluationEntry = InferOutput<typeof bulkEvaluationEntrySchema>;

/**
 * `components/schemas/bulkEvaluationSuccess`.
 *
 * A 200 does not mean every flag evaluated: individual flags fail inside `flags`
 * while the request as a whole succeeds. Only a request-level failure — an
 * unparseable context, say — gets a 400 and a {@link bulkEvaluationFailureSchema}.
 */
export const bulkEvaluationSuccessSchema = looseObject({
  flags: array(bulkEvaluationEntrySchema),
  metadata: optional(metadataSchema),
  eventStreams: optional(array(eventStreamSchema)),
});

export type OfrepBulkEvaluationSuccess = InferOutput<typeof bulkEvaluationSuccessSchema>;

/**
 * `components/schemas/bulkEvaluationFailure`.
 *
 * `errorCode` is an open `string` here, unlike the single-flag failure body: the
 * spec points at the OpenFeature error-code list without enumerating it, so the
 * contract does not close a set the protocol left open.
 */
export const bulkEvaluationFailureSchema = looseObject({
  errorCode: string(),
  errorDetails: optional(errorDetailsSchema),
});

export type OfrepBulkEvaluationFailure = InferOutput<typeof bulkEvaluationFailureSchema>;
