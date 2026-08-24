/**
 * Shared validation primitives for definitions arriving as untrusted JSON.
 *
 * A control plane is just another network dependency: a malformed payload must
 * degrade to "this one definition is ignored", never to a crashed request
 * handler or a silently wrong rollout.
 */

export interface FlagParseIssue {
  /** The key of the definition when it could be read, otherwise its index in the input. */
  readonly at: string;
  readonly message: string;
}

export class FlagParseError extends Error {
  override readonly name = 'FlagParseError';
}

export function fail(message: string): never {
  throw new FlagParseError(message);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isScalarList(value: unknown): value is (string | number)[] {
  return (
    Array.isArray(value) &&
    value.every((item: unknown) => typeof item === 'string' || typeof item === 'number')
  );
}

/**
 * A frozen deep copy of a validated JSON value.
 *
 * A snapshot promises an immutable, point-in-time view, and that promise has
 * two sides.
 *
 * Copying keeps the parsed definition from aliasing the caller's JSON, so
 * whoever still holds the decoded payload cannot change what a live snapshot
 * serves — a provider that caches a response body, a `StaticProvider` handed a
 * live config object, a fixture shared across tests.
 *
 * Freezing keeps the promise on the way out. Variant values and metadata are
 * the two things that travel out of the snapshot on every evaluation result,
 * and they travel by reference: handing back a mutable object would let one
 * caller writing to what it was handed rewrite the flag for every evaluation
 * after it, process-wide. The model types are `readonly` throughout, so this
 * only makes the declared contract true at runtime — and it costs the request
 * path nothing, which a copy per evaluation would not.
 *
 * Hand-rolled rather than `structuredClone`: core does not commit consumers to
 * a platform global (see the TextEncoder note in `bucketing.ts`), and this
 * cannot throw on a value that only looks like JSON.
 */
export function cloneJson<T>(value: T): T {
  if (Array.isArray(value)) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return Object.freeze(value.map((item: unknown) => cloneJson(item))) as T;
  }

  if (isRecord(value)) {
    const copy: Record<string, unknown> = {};
    for (const field of Object.keys(value)) {
      // Defined rather than assigned: `copy['__proto__'] = x` would run the
      // inherited setter and silently drop the key instead of copying it.
      Object.defineProperty(copy, field, {
        value: cloneJson(value[field]),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return Object.freeze(copy) as T;
  }

  return value;
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${field} must be a non-empty string`);
  }
  return value;
}

/**
 * A validated string array, copied rather than handed back by reference.
 *
 * Every list this validates ends up inside a parsed definition — a target's
 * keys, a prerequisite's variant list, a segment's included and excluded keys,
 * the segments an `inSegment` condition names — so returning the caller's own
 * array would leave the definition aliasing the decoded payload. Pushing onto
 * that array afterwards would change who an already-snapshotted rule matches.
 * The no-alias half of {@link cloneJson}, at the one other shape the parser
 * keeps from its input.
 */
export function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item: unknown) => typeof item === 'string')) {
    fail(`${field} must be an array of strings`);
  }
  return [...value];
}

export function requireFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`${field} must be a finite number`);
  }
  return value;
}

/**
 * An optional scalar: absent, or an explicit JSON `null`, reads as `undefined`.
 * Anything else still has to be valid — a malformed salt, seed, or bucketBy
 * rejects the definition rather than being silently dropped, because dropping
 * one quietly reshuffles or reassigns a whole cohort.
 */
export function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireString(value, field);
}

/** The {@link optionalString} rule, for a number field. */
export function optionalFiniteNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  return requireFiniteNumber(value, field);
}
