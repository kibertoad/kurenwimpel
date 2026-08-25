/**
 * Validation for targeting conditions.
 *
 * Shared by flag rules and segment rules, with one asymmetry: segment rules
 * may not use the segment operators, which is what makes segment membership
 * non-recursive and therefore impossible to cycle.
 */

import { parseVersion } from '../evaluation/semver.js';
import type { Condition, ConditionOperator } from '../model/flag.js';
import {
  fail,
  failUnsupportedOperator,
  isRecord,
  isScalarList,
  requireString,
  requireStringArray,
} from './primitives.js';

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
  'semverEq',
  'semverGt',
  'semverGte',
  'semverLt',
  'semverLte',
  'inSegment',
  'notInSegment',
] satisfies ConditionOperator[]);

function isOperator(value: unknown): value is ConditionOperator {
  return typeof value === 'string' && OPERATORS.has(value);
}

/**
 * Validates one condition.
 *
 * `where` prefixes error messages with the owning flag/segment and rule.
 *
 * An operator this version does not know is the one failure that need not cost
 * the definition: it throws with `scope: 'rule'`, and the rule-level callers
 * absorb that by dropping the one rule. See {@link ParseFailureScope}.
 *
 * @throws {FlagParseError} when the shape is not a usable condition.
 */
export function parseCondition(raw: unknown, where: string, allowSegments = true): Condition {
  if (!isRecord(raw)) fail(`${where} has a non-object condition`);

  const operator = raw['operator'];
  if (!isOperator(operator)) {
    failUnsupportedOperator(`${where} has unsupported operator ${String(operator)}`);
  }

  if (operator === 'inSegment' || operator === 'notInSegment') {
    if (!allowSegments) {
      fail(`${where}: segment rules may not use ${operator} — membership does not nest`);
    }
    const segments = requireStringArray(raw['segments'], `${where}: ${operator} segments`);
    if (segments.length === 0) fail(`${where}: ${operator} needs at least one segment key`);
    return { operator, segments };
  }

  const attribute = requireString(raw['attribute'], `${where} attribute`);
  return parseAttributeCondition(operator, attribute, raw['value'], where);
}

function parseAttributeCondition(
  operator: Exclude<ConditionOperator, 'inSegment' | 'notInSegment'>,
  attribute: string,
  value: unknown,
  where: string,
): Condition {
  const at = `${where} condition on ${attribute}`;

  switch (operator) {
    case 'exists':
    case 'notExists': {
      return { attribute, operator };
    }
    case 'eq':
    case 'neq': {
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        fail(`${at}: ${operator} needs a string, number, or boolean value`);
      }
      return { attribute, operator, value };
    }
    case 'in':
    case 'notIn': {
      if (!isScalarList(value)) {
        fail(`${at}: ${operator} needs an array of strings or finite numbers`);
      }
      // Copied for the reason {@link requireStringArray} copies: a condition
      // holding the caller's own array would let a later push into the decoded
      // payload change who an already-snapshotted rule matches.
      return { attribute, operator, value: [...value] };
    }
    case 'contains':
    case 'startsWith':
    case 'endsWith': {
      if (typeof value !== 'string') fail(`${at}: ${operator} needs a string value`);
      return { attribute, operator, value };
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        fail(`${at}: ${operator} needs a finite number value`);
      }
      return { attribute, operator, value };
    }
    case 'semverEq':
    case 'semverGt':
    case 'semverGte':
    case 'semverLt':
    case 'semverLte': {
      if (typeof value !== 'string' || parseVersion(value) === undefined) {
        fail(`${at}: ${operator} needs a semantic version string`);
      }
      return { attribute, operator, value };
    }
  }
}
