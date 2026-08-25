import type { JsonValue } from './json.js';

/**
 * A value a caller may put on an evaluation context.
 *
 * Any JSON is accepted — the same latitude OFREP gives the `context` object —
 * so callers can hand over a user record without filtering it first. Operators
 * are typed: a condition that needs a string simply never matches a value that
 * is not one.
 */
export type AttributeValue = JsonValue;

/**
 * Who (or what) a flag is being evaluated for.
 *
 * The shape is flat, with `targetingKey` alongside the attributes — the exact
 * shape OpenFeature and OFREP use on the wire, so a context arriving over the
 * protocol is a context here, no mapping step.
 *
 * `targetingKey` is the stable identity used for percentage rollouts and
 * individual targeting — a user id, account id, or device id. Without it,
 * nothing bucketed can be evaluated deterministically and those paths fall
 * back to the default variant.
 */
export interface EvaluationContext {
  readonly targetingKey?: string;
  readonly [attribute: string]: AttributeValue | undefined;
}
