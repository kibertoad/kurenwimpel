/**
 * Validation for flag definitions arriving as untrusted JSON.
 *
 * A control plane is just another network dependency: a malformed payload must
 * degrade to "this one flag is ignored", never to a crashed request handler or
 * a silently wrong rollout.
 */

import type {
  Condition,
  ConditionOperator,
  FlagDefinition,
  RolloutBucket,
  TargetingRule,
} from './types.js';

export interface FlagParseIssue {
  /** Flag key when it could be read, otherwise the index in the input. */
  readonly at: string;
  readonly message: string;
}

export interface ParseFlagsResult {
  readonly flags: FlagDefinition[];
  readonly issues: FlagParseIssue[];
}

export class FlagParseError extends Error {
  override readonly name = 'FlagParseError';
}

const OPERATORS = new Set<string>([
  'exists',
  'notExists',
  'eq',
  'neq',
  'in',
  'notIn',
  'contains',
  'startsWith',
  'endsWith',
  'gt',
  'gte',
  'lt',
  'lte',
] satisfies ConditionOperator[]);

function isOperator(value: unknown): value is ConditionOperator {
  return typeof value === 'string' && OPERATORS.has(value);
}

function isScalarList(value: unknown): value is (string | number)[] {
  return (
    Array.isArray(value) &&
    value.every((item: unknown) => typeof item === 'string' || typeof item === 'number')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new FlagParseError(message);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${field} must be a non-empty string`);
  }
  return value;
}

/**
 * Validates one definition.
 *
 * @throws {FlagParseError} when the shape is not a usable flag.
 */
export function parseFlagDefinition(raw: unknown): FlagDefinition {
  if (!isRecord(raw)) fail('flag must be an object');

  const key = requireString(raw['key'], 'key');
  const enabled = raw['enabled'];

  if (typeof enabled !== 'boolean') fail(`flag ${key}: enabled must be a boolean`);

  const variantsRaw = raw['variants'];
  if (!isRecord(variantsRaw)) fail(`flag ${key}: variants must be an object`);

  const variantNames = Object.keys(variantsRaw);
  if (variantNames.length === 0) fail(`flag ${key}: needs at least one variant`);

  const defaultVariant = requireString(raw['defaultVariant'], `flag ${key}: defaultVariant`);
  const offVariant = requireString(raw['offVariant'], `flag ${key}: offVariant`);

  for (const [field, variant] of [
    ['defaultVariant', defaultVariant],
    ['offVariant', offVariant],
  ] as const) {
    if (!variantNames.includes(variant)) {
      fail(`flag ${key}: ${field} points at unknown variant ${variant}`);
    }
  }

  const rules = parseRules(raw['rules'], key, variantNames);
  const rollout = parseRollout(raw['rollout'], key, variantNames);
  const salt = raw['salt'];
  const version = raw['version'];

  return {
    key,
    enabled,
    // Checked above as a non-empty object, and its values came out of JSON.parse,
    // so they are JsonValue by construction.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    variants: variantsRaw as FlagDefinition['variants'],
    defaultVariant,
    offVariant,
    ...(rules === undefined ? {} : { rules }),
    ...(rollout === undefined ? {} : { rollout }),
    ...(typeof salt === 'string' ? { salt } : {}),
    ...(typeof version === 'number' ? { version } : {}),
  };
}

function parseRules(
  raw: unknown,
  key: string,
  variantNames: readonly string[],
): TargetingRule[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) fail(`flag ${key}: rules must be an array`);

  return raw.map((entry: unknown, index: number): TargetingRule => {
    if (!isRecord(entry)) fail(`flag ${key}: rule ${index} must be an object`);

    const id = requireString(entry['id'], `flag ${key}: rule ${index} id`);
    const conditionsRaw = entry['conditions'];
    if (!Array.isArray(conditionsRaw)) {
      fail(`flag ${key}: rule ${id} needs a conditions array`);
    }

    const conditions = conditionsRaw.map((condition: unknown) =>
      parseCondition(condition, key, id),
    );
    const rollout = parseRollout(entry['rollout'], key, variantNames);
    const variantRaw = entry['variant'];

    if (variantRaw !== undefined) {
      const name = requireString(variantRaw, `flag ${key}: rule ${id} variant`);
      if (!variantNames.includes(name)) {
        fail(`flag ${key}: rule ${id} points at unknown variant ${name}`);
      }
    }

    if (variantRaw === undefined && rollout === undefined) {
      fail(`flag ${key}: rule ${id} must declare a variant or a rollout`);
    }

    return {
      id,
      conditions,
      ...(typeof variantRaw === 'string' ? { variant: variantRaw } : {}),
      ...(rollout === undefined ? {} : { rollout }),
    };
  });
}

function parseCondition(raw: unknown, key: string, ruleId: string): Condition {
  if (!isRecord(raw)) fail(`flag ${key}: rule ${ruleId} has a non-object condition`);

  const attribute = requireString(raw['attribute'], `flag ${key}: rule ${ruleId} attribute`);
  const operator = raw['operator'];

  if (!isOperator(operator)) {
    fail(`flag ${key}: rule ${ruleId} has unsupported operator ${String(operator)}`);
  }

  const value = raw['value'];
  const where = `flag ${key}: rule ${ruleId} condition on ${attribute}`;

  switch (operator) {
    case 'exists':
    case 'notExists': {
      return { attribute, operator };
    }
    case 'eq':
    case 'neq': {
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        fail(`${where}: ${operator} needs a string, number, or boolean value`);
      }
      return { attribute, operator, value };
    }
    case 'in':
    case 'notIn': {
      if (!isScalarList(value)) {
        fail(`${where}: ${operator} needs an array of strings or numbers`);
      }
      return { attribute, operator, value };
    }
    case 'contains':
    case 'startsWith':
    case 'endsWith': {
      if (typeof value !== 'string') fail(`${where}: ${operator} needs a string value`);
      return { attribute, operator, value };
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        fail(`${where}: ${operator} needs a finite number value`);
      }
      return { attribute, operator, value };
    }
  }
}

function parseRollout(
  raw: unknown,
  key: string,
  variantNames: readonly string[],
): RolloutBucket[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) fail(`flag ${key}: rollout must be an array`);
  if (raw.length === 0) return undefined;

  return raw.map((entry: unknown, index: number): RolloutBucket => {
    if (!isRecord(entry)) fail(`flag ${key}: rollout bucket ${index} must be an object`);

    const variant = requireString(entry['variant'], `flag ${key}: rollout bucket ${index} variant`);
    if (!variantNames.includes(variant)) {
      fail(`flag ${key}: rollout points at unknown variant ${variant}`);
    }

    const weight = entry['weight'];
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0) {
      fail(`flag ${key}: rollout bucket ${variant} needs a non-negative finite weight`);
    }

    return { variant, weight };
  });
}

/**
 * Validates a batch, keeping the flags that parse and collecting issues for the
 * ones that do not. One bad flag should not take down the whole ruleset.
 *
 * Accepts either an array of definitions or a key-to-definition object.
 */
export function parseFlagDefinitions(raw: unknown): ParseFlagsResult {
  if (!Array.isArray(raw) && !isRecord(raw)) {
    return {
      flags: [],
      issues: [{ at: 'root', message: 'expected an array or object of flags' }],
    };
  }

  const entries: [string, unknown][] = Array.isArray(raw)
    ? raw.map((entry: unknown, index: number): [string, unknown] => [String(index), entry])
    : Object.entries(raw);

  const flags: FlagDefinition[] = [];
  const issues: FlagParseIssue[] = [];

  for (const [at, entry] of entries) {
    try {
      flags.push(parseFlagDefinition(entry));
    } catch (error) {
      issues.push({
        at: isRecord(entry) && typeof entry['key'] === 'string' ? entry['key'] : at,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { flags, issues };
}
