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
