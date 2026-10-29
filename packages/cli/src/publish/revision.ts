import { createHash } from 'node:crypto';

/**
 * JSON with every object's keys sorted and no whitespace, so two documents that
 * differ only in key order or formatting serialize to the same bytes.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

/** The hex SHA-256 of a payload. */
export function sha256Hex(payload: string): string {
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

export interface RevisionedPayload {
  /** The hex SHA-256 of `payload`. Identical content always gets the same revision. */
  readonly revision: string;
  /** The canonical JSON that gets written. */
  readonly payload: string;
}

export function revisionOf(document: unknown): RevisionedPayload {
  const payload = canonicalJson(document);
  return { revision: sha256Hex(payload), payload };
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item: unknown) => sortKeys(item));
  if (typeof value !== 'object' || value === null) return value;

  const entries = Object.entries(value).toSorted(([a], [b]) => (a < b ? -1 : 1));
  return Object.fromEntries(entries.map(([key, entry]) => [key, sortKeys(entry)]));
}
