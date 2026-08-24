/**
 * Shared building blocks of the OFREP contract: the pieces the specification
 * factors out into `components/schemas` and references from more than one place.
 *
 * Every object schema in this package is a valibot `looseObject`. OFREP is a
 * versioned, still-evolving protocol whose implementations are told to ignore
 * fields they do not recognise, so unknown properties are carried through the
 * parse rather than stripped (`object`) or rejected (`strictObject`). A client
 * built against v0.3.0 therefore keeps working against a v0.4.0 server, and a
 * server keeps whatever a newer client sent.
 */

import type { InferOutput } from 'valibot';
import {
  boolean,
  custom,
  intersect,
  looseObject,
  number,
  picklist,
  record,
  string,
  union,
} from 'valibot';

/** The protocol revision this contract was transcribed from. */
export const OFREP_PROTOCOL_VERSION = '0.3.0';

/** Path prefix every OFREP route lives under. */
export const OFREP_BASE_PATH = '/ofrep/v1';

/** Path both evaluation routes are built from. */
export const OFREP_EVALUATE_PATH = `${OFREP_BASE_PATH}/evaluate/flags`;

/**
 * JSON Schema's `type: object` excludes arrays, but valibot's `record` accepts
 * one and silently rewrites it to `{ "0": ... }`. A `check` cannot undo that —
 * it runs on the already-rewritten output — so arrays are rejected by this
 * guard *before* any `record` sees them.
 */
const isJsonObject = (input: unknown): boolean =>
  typeof input === 'object' && input !== null && !Array.isArray(input);

/** `type: object` with `additionalProperties: true`: any JSON object, no constraint on its values. */
export const jsonObjectSchema = custom<Readonly<Record<string, unknown>>>(
  isJsonObject,
  'Expected a JSON object',
);

export type JsonObject = InferOutput<typeof jsonObjectSchema>;

/** `components/schemas/key` — the unique identifier of a feature flag. */
export const flagKeySchema = string();

/** `components/schemas/errorDetails` — human-readable context for logs and debugging. */
export const errorDetailsSchema = string();

/**
 * `components/schemas/metadata` — arbitrary flag or flag-set metadata for
 * telemetry and documentation. Values are restricted to JSON primitives.
 */
export const metadataSchema = intersect([
  jsonObjectSchema,
  record(string(), union([boolean(), string(), number()])),
]);

export type OfrepMetadata = InferOutput<typeof metadataSchema>;

/**
 * Resolution reasons OFREP admits. Narrower than the OpenFeature specification's
 * own list: `DEFAULT`, `CACHED` and `ERROR` are not wire values here — a failed
 * evaluation is reported as an `evaluationFailure` rather than as a success
 * carrying `reason: ERROR`.
 */
export const OFREP_REASONS = ['STATIC', 'TARGETING_MATCH', 'SPLIT', 'DISABLED', 'UNKNOWN'] as const;

export type OfrepReason = (typeof OFREP_REASONS)[number];

export const ofrepReasonSchema = picklist(OFREP_REASONS);

/**
 * Error codes a single-flag evaluation may fail with. `FLAG_NOT_FOUND` is
 * deliberately absent: the spec models it as its own 404 response body, because
 * an unknown key is an expected outcome in some flag management systems rather
 * than an evaluation error.
 */
export const OFREP_EVALUATION_ERROR_CODES = [
  'PARSE_ERROR',
  'TARGETING_KEY_MISSING',
  'INVALID_CONTEXT',
  'GENERAL',
] as const;

export type OfrepEvaluationErrorCode = (typeof OFREP_EVALUATION_ERROR_CODES)[number];

export const ofrepEvaluationErrorCodeSchema = picklist(OFREP_EVALUATION_ERROR_CODES);

/** The sole error code carried by a 404 response body. */
export const FLAG_NOT_FOUND_ERROR_CODE = 'FLAG_NOT_FOUND';

/**
 * `components/schemas/context` — who the flag is being evaluated for.
 *
 * `targetingKey` is required by OFREP even though the OpenFeature specification
 * treats it as optional, so a client that evaluates without a subject still has
 * to supply one.
 */
export const evaluationContextSchema = looseObject({ targetingKey: string() });

export type OfrepEvaluationContext = InferOutput<typeof evaluationContextSchema>;
