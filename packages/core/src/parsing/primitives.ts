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
 * A deep copy of a validated JSON value.
 *
 * A snapshot promises an immutable, point-in-time view, and returning the
 * caller's own object would break that promise the moment anyone still holding
 * the decoded payload touched it — a provider that caches a response body, a
 * `StaticProvider` handed a live config object, a fixture shared across tests.
 *
 * Hand-rolled rather than `structuredClone`: core does not commit consumers to
 * a platform global (see the TextEncoder note in `bucketing.ts`), and this
 * cannot throw on a value that only looks like JSON.
 */
export function cloneJson<T>(value: T): T {
  if (Array.isArray(value)) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return value.map((item: unknown) => cloneJson(item)) as T;
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
    return copy as T;
  }

  return value;
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${field} must be a non-empty string`);
  }
  return value;
}

export function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item: unknown) => typeof item === 'string')) {
    fail(`${field} must be an array of strings`);
  }
  return value;
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
