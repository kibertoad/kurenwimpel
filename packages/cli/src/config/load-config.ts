import { dirname, isAbsolute, join } from 'node:path';

import type { CliIo } from '../command.js';
import { parseJson, readText } from '../ruleset-file.js';
import {
  ConfigError,
  objectAt,
  onlyFields,
  optionalKeep,
  optionalOwners,
  pickStrings,
  requiredString,
} from './fields.js';
import type { Fields } from './fields.js';
import type { EnvironmentConfig, KurenwimpelConfig, TargetConfig } from './types.js';

export interface LoadedConfig {
  readonly path: string;
  readonly config: KurenwimpelConfig;
}

export async function loadConfig(io: CliIo, path: string): Promise<LoadedConfig> {
  const raw = parseJson(await readText(io, path), path);
  return { path, config: parseConfig(raw, path) };
}

/** Validates a parsed config document. Every problem is a {@link ConfigError}. */
export function parseConfig(raw: unknown, source: string): KurenwimpelConfig {
  const root = objectAt(raw, source);
  onlyFields(root, ['$schema', 'environments'], source);

  const environments = objectAt(root['environments'], `${source}: environments`);
  const parsed: Record<string, EnvironmentConfig> = {};
  for (const [name, value] of Object.entries(environments)) {
    const at = `${source}: environments.${name}`;
    parsed[name] = parseEnvironment(objectAt(value, at), at);
  }
  return { environments: parsed };
}

function parseEnvironment(fields: Fields, at: string): EnvironmentConfig {
  onlyFields(fields, ['target', 'ruleset', 'schedule', 'approvers'], at);
  const approvers = optionalOwners(fields, 'approvers', at);
  return {
    target: parseTarget(fields['target'], `${at}.target`),
    ...pickStrings(fields, ['ruleset', 'schedule'], at),
    ...(approvers === undefined ? {} : { approvers }),
  };
}

/** The config entry of `<env>`, or a {@link ConfigError} naming the environments that exist. */
export function environmentOf(loaded: LoadedConfig, environment: string): EnvironmentConfig {
  const { environments } = loaded.config;
  if (!Object.hasOwn(environments, environment)) {
    const known = Object.keys(environments).join(', ') || 'none';
    throw new ConfigError(
      `environment "${environment}" is not in ${loaded.path} (configured: ${known})`,
    );
  }
  return environments[environment]!;
}

/**
 * The target `<env>` publishes to, with a relative file path resolved against
 * the directory holding the config file.
 */
export function resolveTarget(loaded: LoadedConfig, environment: string): TargetConfig {
  const { target } = environmentOf(loaded, environment);
  if (target.type !== 'file') return target;
  return { ...target, path: relativeToConfig(loaded, target.path) };
}

/** The ruleset document of `<env>`, resolved the same way. Defaults to `<env>.json`. */
export function resolveRuleset(loaded: LoadedConfig, environment: string): string {
  const { ruleset = `${environment}.json` } = environmentOf(loaded, environment);
  return relativeToConfig(loaded, ruleset);
}

/** The schedule file of `<env>`, resolved the same way. Defaults to `<env>.schedule.json`. */
export function resolveSchedule(loaded: LoadedConfig, environment: string): string {
  const { schedule = `${environment}.schedule.json` } = environmentOf(loaded, environment);
  return relativeToConfig(loaded, schedule);
}

function relativeToConfig(loaded: LoadedConfig, path: string): string {
  return isAbsolute(path) ? path : join(dirname(loaded.path), path);
}

function parseTarget(value: unknown, at: string): TargetConfig {
  const fields = objectAt(value, at);
  const type = fields['type'];
  switch (type) {
    case 'kv':
      return parseKv(fields, at);
    case 'file':
      return parseFile(fields, at);
    case 's3':
    case 'r2':
      return parseObject(fields, type, at);
    default:
      throw new ConfigError(`${at}.type must be one of: kv, file, s3, r2`);
  }
}

function parseKv(fields: Fields, at: string): TargetConfig {
  const optional = ['accountId', 'key', 'revisionPrefix', 'apiTokenEnv'] as const;
  onlyFields(fields, ['type', 'namespaceId', 'keep', ...optional], at);
  return {
    type: 'kv',
    namespaceId: requiredString(fields, 'namespaceId', at),
    ...pickStrings(fields, optional, at),
    ...keepOf(fields, at),
  };
}

function parseFile(fields: Fields, at: string): TargetConfig {
  onlyFields(fields, ['type', 'path', 'keep'], at);
  return { type: 'file', path: requiredString(fields, 'path', at), ...keepOf(fields, at) };
}

function parseObject(fields: Fields, type: 's3' | 'r2', at: string): TargetConfig {
  const optional = [
    'endpoint',
    'region',
    'accountId',
    'accessKeyIdEnv',
    'secretAccessKeyEnv',
    'sessionTokenEnv',
  ] as const;
  onlyFields(fields, ['type', 'bucket', 'key', ...optional], at);
  return {
    type,
    bucket: requiredString(fields, 'bucket', at),
    key: requiredString(fields, 'key', at),
    ...pickStrings(fields, optional, at),
  };
}

function keepOf(fields: Fields, at: string): { keep?: number } {
  const keep = optionalKeep(fields, at);
  return keep === undefined ? {} : { keep };
}
