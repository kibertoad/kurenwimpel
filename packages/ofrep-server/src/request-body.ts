import type { EvaluationContext } from '@kurenwimpel/core';
import { evaluationRequestSchema } from '@kurenwimpel/ofrep';
import * as z from 'zod/mini';

export type BodyErrorCode = 'PARSE_ERROR' | 'INVALID_CONTEXT' | 'TARGETING_KEY_MISSING';

export type ContextOutcome =
  | { readonly ok: true; readonly context: EvaluationContext }
  | { readonly ok: false; readonly errorCode: BodyErrorCode; readonly errorDetails: string };

/**
 * Reads the `{ context }` body both routes share. The bulk request schema is
 * the same shape as the single-flag one, so one reader serves both.
 */
export async function readContext(request: Request): Promise<ContextOutcome> {
  let body: unknown;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return failure('PARSE_ERROR', 'Request body is not valid JSON');
  }

  const parsed = z.safeParse(evaluationRequestSchema, body);
  if (parsed.success) {
    // A JSON-parsed context holds only JSON values, which is what the core accepts.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return { ok: true, context: parsed.data.context as EvaluationContext };
  }

  // With `context` an object, the schema's only remaining demand is a string targetingKey.
  return isObject(body) && isObject(body['context'])
    ? failure('TARGETING_KEY_MISSING', 'context.targetingKey must be a string')
    : failure('INVALID_CONTEXT', 'Request body must be an object with a context object');
}

function failure(errorCode: BodyErrorCode, errorDetails: string): ContextOutcome {
  return { ok: false, errorCode, errorDetails };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
