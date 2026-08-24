/**
 * JSON-compatible value types.
 *
 * The whole domain model is built from these: flag definitions arrive as JSON
 * from a control plane, and evaluation results must be expressible on the wire
 * of the OpenFeature Remote Evaluation Protocol (`@kurenwimpel/ofrep`).
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** A JSON object — the only compound shape OFREP allows a flag value to be. */
export type JsonObject = { readonly [key: string]: JsonValue };

/**
 * The value a variant resolves to.
 *
 * Deliberately narrower than {@link JsonValue}: OFREP's `evaluationSuccess` is
 * a union of boolean, string, number, and object, so a top-level `null` or
 * array has no wire representation. The core refuses to model one — the gap
 * would otherwise surface as an unserveable flag, discovered only when the
 * protocol layer is built. An array-shaped value nests inside an object
 * instead: `{ "hosts": ["a", "b"] }`.
 */
export type FlagValue = boolean | string | number | JsonObject;
