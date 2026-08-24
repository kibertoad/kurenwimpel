/**
 * Validation for segment definitions.
 */

import type { SegmentDefinition, SegmentRule } from '../model/segment.js';
import { parseCondition } from './condition.js';
import { fail, isRecord, requireString, requireStringArray } from './primitives.js';

/**
 * Validates one segment definition.
 *
 * @throws {FlagParseError} when the shape is not a usable segment.
 */
export function parseSegmentDefinition(raw: unknown): SegmentDefinition {
  if (!isRecord(raw)) fail('segment must be an object');

  const key = requireString(raw['key'], 'segment key');
  const included = parseKeyList(raw['included'], key, 'included');
  const excluded = parseKeyList(raw['excluded'], key, 'excluded');
  const rules = parseSegmentRules(raw['rules'], key);

  // Content, not presence. A segment whose criteria are all empty lists can
  // never match anybody, so every `inSegment` naming it matches nobody and
  // every `notInSegment` matches everybody, forever and without complaint —
  // the same silence a misspelled segment key is checked for in
  // `references.ts`, reached through a different door. An operator who emptied
  // the list in the UI gets an issue rather than nothing.
  const criteria = (included?.length ?? 0) + (excluded?.length ?? 0) + (rules?.length ?? 0);
  if (criteria === 0) {
    fail(`segment ${key}: needs a non-empty included, excluded, or rules list`);
  }

  return {
    key,
    ...(included === undefined ? {} : { included }),
    ...(excluded === undefined ? {} : { excluded }),
    ...(rules === undefined ? {} : { rules }),
  };
}

function parseKeyList(
  raw: unknown,
  key: string,
  field: 'included' | 'excluded',
): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  return requireStringArray(raw, `segment ${key}: ${field}`);
}

function parseSegmentRules(raw: unknown, key: string): SegmentRule[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) fail(`segment ${key}: rules must be an array`);

  return raw.map((entry: unknown, index: number): SegmentRule => {
    if (!isRecord(entry)) fail(`segment ${key}: rule ${index} must be an object`);

    const id = requireString(entry['id'], `segment ${key}: rule ${index} id`);
    const conditionsRaw = entry['conditions'];
    if (!Array.isArray(conditionsRaw) || conditionsRaw.length === 0) {
      fail(`segment ${key}: rule ${id} needs a non-empty conditions array`);
    }

    // Segment operators are rejected inside segment rules: membership that
    // cannot recurse is membership that cannot cycle.
    const conditions = conditionsRaw.map((condition: unknown) =>
      parseCondition(condition, `segment ${key}: rule ${id}`, false),
    );

    return { id, conditions };
  });
}
