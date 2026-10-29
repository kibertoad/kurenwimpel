import type { FlagParseIssue } from './primitives.js';

/** The newest ruleset format this engine reads in full. See ADR 0010. */
export const SUPPORTED_SCHEMA_VERSION = 1;

/**
 * Reports a document's `schemaVersion` without ever rejecting the ruleset: a
 * newer document still loads, and whatever this engine cannot read fails closed.
 */
export function checkSchemaVersion(raw: unknown): FlagParseIssue[] {
  if (raw === undefined || raw === null) return [];

  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    return [{ at: 'schemaVersion', message: 'schemaVersion must be a positive integer' }];
  }

  if (raw <= SUPPORTED_SCHEMA_VERSION) return [];

  return [
    {
      at: 'schemaVersion',
      message:
        `schemaVersion ${raw} is newer than ${SUPPORTED_SCHEMA_VERSION}, the newest this SDK ` +
        'supports. The ruleset is loaded; anything this version cannot read fails closed.',
    },
  ];
}
