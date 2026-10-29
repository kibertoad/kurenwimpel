import type { AttributeValue, EvaluationContext } from '@kurenwimpel/core';
import type { EvaluationContext as OpenFeatureContext } from '@openfeature/server-sdk';

/**
 * Converts an OpenFeature context to the engine's flat JSON context.
 *
 * A top-level `Date` becomes epoch millis, so `gt`/`lt` conditions can compare
 * it. Everything else, nested objects included, is passed through unchanged.
 */
export function toEngineContext(context: OpenFeatureContext): EvaluationContext {
  const mapped: Record<string, AttributeValue | undefined> = {};
  for (const [key, value] of Object.entries(context)) {
    // A nested Date stays a Date: no operator matches an object, so it fails closed.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    mapped[key] = value instanceof Date ? value.getTime() : (value as AttributeValue | undefined);
  }
  return mapped;
}
