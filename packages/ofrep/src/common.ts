/**
 * Shared building blocks of the OFREP contract: the pieces the specification
 * factors out into `components/schemas` and references from more than one place.
 *
 * Every object schema in this package is a zod `looseObject`. OFREP is a
 * versioned, still-evolving protocol whose implementations are told to ignore
 * fields they do not recognise, so unknown properties are carried through the
 * parse rather than stripped (`object`) or rejected (`strictObject`). A client
 * built against v0.3.0 therefore keeps working against a v0.4.0 server, and a
 * server keeps whatever a newer client sent.
 */

import * as z from 'zod/mini';

/** The protocol revision this contract was transcribed from. */
export const OFREP_PROTOCOL_VERSION = '0.3.0';

/** Path prefix every OFREP route lives under. */
export const OFREP_BASE_PATH = '/ofrep/v1';

/** Path both evaluation routes are built from. */
export const OFREP_EVALUATE_PATH = `${OFREP_BASE_PATH}/evaluate/flags`;

/**
 * `type: object` with `additionalProperties: true`: any JSON object, no
 * constraint on its values.
 *
 * JSON Schema's `type: object` excludes arrays and null, and zod's `record`
 * agrees — it rejects both rather than coercing an array into `{ "0": ... }`.
 * That is what makes this a faithful reading rather than a lenient one, and it
 * is worth knowing before anyone loosens it to `z.unknown()`.
 */
export const jsonObjectSchema = z.record(z.string(), z.unknown());

export type JsonObject = z.infer<typeof jsonObjectSchema>;

/** `components/schemas/key` — the unique identifier of a feature flag. */
export const flagKeySchema = z.string();

/** `components/schemas/errorDetails` — human-readable context for logs and debugging. */
export const errorDetailsSchema = z.string();

/**
 * `components/schemas/metadata` — arbitrary flag or flag-set metadata for
 * telemetry and documentation. Values are restricted to JSON primitives.
 */
export const metadataSchema = z.record(z.string(), z.union([z.boolean(), z.string(), z.number()]));

export type OfrepMetadata = z.infer<typeof metadataSchema>;

/**
 * Resolution reasons OFREP admits. Narrower than the OpenFeature specification's
 * own list: `DEFAULT`, `CACHED` and `ERROR` are not wire values here — a failed
 * evaluation is reported as an `evaluationFailure` rather than as a success
 * carrying `reason: ERROR`.
 */
export const OFREP_REASONS = ['STATIC', 'TARGETING_MATCH', 'SPLIT', 'DISABLED', 'UNKNOWN'] as const;

export type OfrepReason = (typeof OFREP_REASONS)[number];

export const ofrepReasonSchema = z.enum(OFREP_REASONS);

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

export const ofrepEvaluationErrorCodeSchema = z.enum(OFREP_EVALUATION_ERROR_CODES);

/** The sole error code carried by a 404 response body. */
export const FLAG_NOT_FOUND_ERROR_CODE = 'FLAG_NOT_FOUND';

/**
 * `components/schemas/context` — who the flag is being evaluated for.
 *
 * `targetingKey` is required by OFREP even though the OpenFeature specification
 * treats it as optional, so a client that evaluates without a subject still has
 * to supply one.
 */
export const evaluationContextSchema = z.looseObject({ targetingKey: z.string() });

export type OfrepEvaluationContext = z.infer<typeof evaluationContextSchema>;
