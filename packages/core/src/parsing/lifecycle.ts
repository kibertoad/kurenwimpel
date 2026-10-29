/**
 * Validation for the `lifecycle` block of a flag.
 *
 * No evaluation path reads it, so a defect is reported as a warning and only the
 * bad field is dropped: rejecting the flag over a misspelled owner would take a
 * working flag out of service. The same reasoning as `tolerantVersion`.
 */

import type { FlagKind, FlagLifecycle } from '../model/flag.js';
import { isRecord } from './primitives.js';
import type { FlagParseIssue } from './primitives.js';

export const FLAG_KINDS: readonly FlagKind[] = ['release', 'experiment', 'ops', 'permission'];

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;

type Read = <T>(
  field: string,
  test: (value: unknown) => value is T,
  defect: string,
) => T | undefined;

export function parseLifecycle(
  raw: unknown,
  key: string,
  warnings: FlagParseIssue[] | undefined,
): FlagLifecycle | undefined {
  if (raw === undefined || raw === null) return undefined;

  const warn = (message: string): void => {
    warnings?.push({
      at: key,
      message: `flag ${key}: ${message}, ignored; the flag is still served`,
    });
  };

  if (!isRecord(raw)) {
    warn('lifecycle must be an object');
    return undefined;
  }

  const read: Read = (field, test, defect) => {
    const value = raw[field] ?? undefined;
    const usable = value === undefined || test(value);
    if (!usable) warn(`lifecycle ${field} ${defect}`);
    return usable ? value : undefined;
  };

  const owner = read('owner', isNonEmptyString, 'must be a non-empty string');
  const kind = read('kind', isFlagKind, `must be one of ${FLAG_KINDS.join(', ')}`);
  const expiresOn = read('expiresOn', isCalendarDate, 'must be a calendar date written YYYY-MM-DD');
  const tags = read('tags', isTagList, 'must be an array of non-empty strings');

  return {
    ...(owner === undefined ? {} : { owner }),
    ...(kind === undefined ? {} : { kind }),
    ...(expiresOn === undefined ? {} : { expiresOn }),
    ...(tags === undefined ? {} : { tags: [...tags] }),
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isFlagKind(value: unknown): value is FlagKind {
  return FLAG_KINDS.some((kind) => kind === value);
}

function isTagList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((tag) => isNonEmptyString(tag));
}

function isCalendarDate(value: unknown): value is string {
  const match = typeof value === 'string' ? DATE.exec(value) : null;
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}
