/**
 * Validation for hashed key lists.
 */

import type { HashedKeyList } from '../model/flag.js';
import { fail, isRecord } from './primitives.js';

const SHA256_HEX = /^[0-9a-f]{64}$/u;

/**
 * Validates `{ algorithm: 'sha256', values: [...] }`.
 *
 * Every value must be 64 lowercase hex characters. Uppercase is rejected
 * rather than folded: the evaluator compares digests as strings, and a list
 * that only matches after normalisation is a list some other consumer of the
 * ruleset will read differently.
 *
 * @throws {FlagParseError} when the list is not usable.
 */
export function parseHashedKeyList(raw: unknown, where: string): HashedKeyList | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) fail(`${where} must be an object with algorithm and values`);

  const algorithm = raw['algorithm'];
  if (algorithm !== 'sha256') fail(`${where}: algorithm must be "sha256"`);

  const values = raw['values'];
  if (!Array.isArray(values)) fail(`${where}: values must be an array`);

  for (const [index, value] of (values as unknown[]).entries()) {
    if (typeof value !== 'string' || !SHA256_HEX.test(value)) {
      fail(`${where}: value ${index} must be a SHA-256 digest in 64 lowercase hex characters`);
    }
  }

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return { algorithm, values: [...(values as string[])] };
}
