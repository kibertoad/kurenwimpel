/**
 * @kurenwimpel/ofrep — the OpenFeature Remote Evaluation Protocol as an
 * executable contract.
 *
 * A transcription of the OFREP OpenAPI document into `defineApiContract` routes
 * and Standard Schema definitions, with no dependency on this repository's
 * evaluation engine. It describes the protocol; it does not implement either
 * side of it.
 */

export {
  bulkEvaluationEntrySchema,
  bulkEvaluationFailureSchema,
  bulkEvaluationRequestSchema,
  bulkEvaluationSuccessSchema,
} from './bulk.js';
export type {
  OfrepBulkEvaluationEntry,
  OfrepBulkEvaluationFailure,
  OfrepBulkEvaluationRequest,
  OfrepBulkEvaluationSuccess,
} from './bulk.js';

export {
  errorDetailsSchema,
  evaluationContextSchema,
  flagKeySchema,
  FLAG_NOT_FOUND_ERROR_CODE,
  jsonObjectSchema,
  metadataSchema,
  ofrepEvaluationErrorCodeSchema,
  ofrepReasonSchema,
  OFREP_BASE_PATH,
  OFREP_EVALUATE_PATH,
  OFREP_EVALUATION_ERROR_CODES,
  OFREP_PROTOCOL_VERSION,
  OFREP_REASONS,
} from './common.js';
export type {
  JsonObject,
  OfrepEvaluationContext,
  OfrepEvaluationErrorCode,
  OfrepMetadata,
  OfrepReason,
} from './common.js';

export {
  evaluateFlagContract,
  evaluateFlagPathParamsSchema,
  evaluateFlagsBulkContract,
  OFREP_CONTRACTS,
} from './contracts.js';

export {
  booleanEvaluationSchema,
  codeDefaultEvaluationSchema,
  evaluationFailureSchema,
  evaluationRequestSchema,
  evaluationSuccessSchema,
  flagNotFoundSchema,
  floatEvaluationSchema,
  generalErrorResponseSchema,
  integerEvaluationSchema,
  objectEvaluationSchema,
  serverEvaluationSuccessSchema,
  stringEvaluationSchema,
} from './evaluation.js';
export type {
  OfrepEvaluationFailure,
  OfrepEvaluationRequest,
  OfrepEvaluationSuccess,
  OfrepFlagNotFound,
  OfrepGeneralError,
} from './evaluation.js';

export {
  endpointEventStreamSchema,
  eventStreamEndpointSchema,
  eventStreamSchema,
  flagConfigLastModifiedSchema,
  sseEventDataSchema,
  sseEventSchema,
  urlEventStreamSchema,
  DEFAULT_INACTIVITY_DELAY_SECONDS,
  REFETCH_EVALUATION_EVENT_TYPE,
  SSE_EVENT_STREAM_TYPE,
} from './event-stream.js';
export type {
  FlagConfigLastModified,
  OfrepEventStream,
  OfrepEventStreamEndpoint,
  OfrepSseEvent,
  OfrepSseEventData,
} from './event-stream.js';

export {
  bulkEvaluationQuerySchema,
  bulkEvaluationRequestHeadersSchema,
  ofrepAuthHeadersSchema,
  ofrepResponseHeadersSchema,
} from './http.js';
export type {
  OfrepAuthHeaders,
  OfrepBulkQuery,
  OfrepBulkRequestHeaders,
  OfrepResponseHeaders,
} from './http.js';
