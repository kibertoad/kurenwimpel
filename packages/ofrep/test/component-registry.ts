/**
 * Which schema in `src/` stands for each `components/schemas` entry of the
 * vendored document.
 *
 * The map is exhaustive by test: a schema added, renamed or removed upstream
 * fails `spec-conformance.test.ts` until it is accounted for here. That is the
 * point of writing it out rather than deriving it from the schemas' names —
 * a name-based lookup would silently stop covering a component the day upstream
 * renamed one.
 *
 * Three kinds of entry:
 *
 * - `schema` — compared shape-for-shape against the document.
 * - `via` — has no schema of its own here because it is a fragment of a
 *   composite (the six flag types are `oneOf` arms of `evaluationSuccess`, and
 *   are checked where that composition is checked).
 * - `annotationOnly` — carries a description or an example and no shape at all.
 */

import {
  bulkEvaluationFailureSchema,
  bulkEvaluationRequestSchema,
  bulkEvaluationSuccessSchema,
  errorDetailsSchema,
  evaluationContextSchema,
  evaluationFailureSchema,
  evaluationRequestSchema,
  evaluationSuccessSchema,
  eventStreamEndpointSchema,
  eventStreamSchema,
  flagKeySchema,
  flagNotFoundSchema,
  generalErrorResponseSchema,
  metadataSchema,
  serverEvaluationSuccessSchema,
  sseEventDataSchema,
  sseEventSchema,
} from '../src/index.js';

export type ComponentEntry =
  | { readonly schema: unknown }
  | { readonly via: string }
  | { readonly annotationOnly: true };

export const COMPONENT_REGISTRY: Record<string, ComponentEntry> = {
  bulkEvaluationRequest: { schema: bulkEvaluationRequestSchema },
  bulkEvaluationSuccess: { schema: bulkEvaluationSuccessSchema },
  bulkEvaluationFailure: { schema: bulkEvaluationFailureSchema },
  evaluationRequest: { schema: evaluationRequestSchema },
  evaluationSuccess: { schema: evaluationSuccessSchema },
  serverEvaluationSuccess: { schema: serverEvaluationSuccessSchema },
  evaluationFailure: { schema: evaluationFailureSchema },
  flagNotFound: { schema: flagNotFoundSchema },
  generalErrorResponse: { schema: generalErrorResponseSchema },
  eventStream: { schema: eventStreamSchema },
  eventStreamEndpoint: { schema: eventStreamEndpointSchema },
  sseEvent: { schema: sseEventSchema },
  sseEventData: { schema: sseEventDataSchema },
  context: { schema: evaluationContextSchema },
  key: { schema: flagKeySchema },
  errorDetails: { schema: errorDetailsSchema },
  metadata: { schema: metadataSchema },

  booleanFlag: { via: 'evaluationSuccess' },
  stringFlag: { via: 'evaluationSuccess' },
  integerFlag: { via: 'evaluationSuccess' },
  floatFlag: { via: 'evaluationSuccess' },
  objectFlag: { via: 'evaluationSuccess' },
  codeDefaultFlag: { via: 'evaluationSuccess' },

  flagMetadataDescription: { annotationOnly: true },
  flagMetadataExamples: { annotationOnly: true },
};

/** The schema standing for a component, or `undefined` for a `via`/annotation entry. */
export const schemaForComponent = (name: string): unknown => {
  const entry = COMPONENT_REGISTRY[name];
  return entry !== undefined && 'schema' in entry ? entry.schema : undefined;
};

/** `#/components/schemas/x` → `x`. */
export const componentNameOf = (ref: string): string => ref.replace('#/components/schemas/', '');
