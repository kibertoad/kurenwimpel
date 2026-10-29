import { UsageError } from '../command.js';
import { isRecord } from '../json.js';

/** A config field that is not what it should be. Exits with code 2, like any unreadable input. */
export class ConfigError extends UsageError {}

export type Fields = Readonly<Record<string, unknown>>;

/** Fields that would put a secret in a committed file, and the field to use instead. */
const SECRET_FIELDS: Readonly<Record<string, string>> = {
  apiToken: 'apiTokenEnv',
  token: 'apiTokenEnv',
  accessKeyId: 'accessKeyIdEnv',
  secretAccessKey: 'secretAccessKeyEnv',
  sessionToken: 'sessionTokenEnv',
};

export function objectAt(value: unknown, at: string): Fields {
  if (!isRecord(value)) throw new ConfigError(`${at} must be an object`);
  return value;
}

/** Rejects any field outside `allowed`, so a typo fails instead of silently using a default. */
export function onlyFields(fields: Fields, allowed: readonly string[], at: string): void {
  for (const name of Object.keys(fields)) {
    if (allowed.includes(name)) continue;
    const instead = SECRET_FIELDS[name];
    if (instead !== undefined) {
      throw new ConfigError(
        `${at}.${name}: credentials come from environment variables only; name the variable with ${instead}`,
      );
    }
    throw new ConfigError(`${at}.${name} is not a known field (expected ${allowed.join(', ')})`);
  }
}

export function requiredString(fields: Fields, name: string, at: string): string {
  const value = optionalString(fields, name, at);
  if (value === undefined) throw new ConfigError(`${at}.${name} is required`);
  return value;
}

export function optionalString(fields: Fields, name: string, at: string): string | undefined {
  const value = fields[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new ConfigError(`${at}.${name} must be a non-empty string`);
  }
  return value;
}

export function optionalKeep(fields: Fields, at: string): number | undefined {
  const value = fields['keep'];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new ConfigError(`${at}.keep must be a whole number of at least 1`);
  }
  return value;
}

/** Copies the optional string fields that are set, so `exactOptionalPropertyTypes` holds. */
export function pickStrings<K extends string>(
  fields: Fields,
  names: readonly K[],
  at: string,
): Partial<Record<K, string>> {
  const picked: Partial<Record<K, string>> = {};
  for (const name of names) {
    const value = optionalString(fields, name, at);
    if (value !== undefined) picked[name] = value;
  }
  return picked;
}

/** CODEOWNERS owners. Whitespace would split one owner into two on a CODEOWNERS line. */
export function optionalOwners(fields: Fields, name: string, at: string): string[] | undefined {
  const value = fields[name];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || !value.every((owner) => isOwner(owner))) {
    throw new ConfigError(`${at}.${name} must be a non-empty array of owners without spaces`);
  }
  return value;
}

function isOwner(value: unknown): value is string {
  return typeof value === 'string' && /^\S+$/u.test(value);
}
