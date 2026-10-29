import type { FlagSnapshot } from '@kurenwimpel/core';

/**
 * The bulk route's ETag: a hash of the snapshot identity and the context.
 *
 * Callers take it before evaluating. A snapshot swapped in meanwhile then pairs
 * a newer body with an older tag, which costs one refetch and never serves stale flags.
 */
export async function bulkEtag(snapshot: FlagSnapshot, context: unknown): Promise<string> {
  // Without a control-plane revision, the load time is the only identity a snapshot has.
  const identity = snapshot.version ?? snapshot.fetchedAt;
  const input = new TextEncoder().encode(canonicalJson([identity, context]));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
  const hex = Array.from(digest.subarray(0, 16), (byte) => byte.toString(16).padStart(2, '0'));
  return `"${hex.join('')}"`;
}

/** Whether an `If-None-Match` header names this tag. Weak tags compare by their opaque part. */
export function matchesEtag(header: string | null, etag: string): boolean {
  if (header === null) return false;
  return header.split(',').some((candidate) => {
    const tag = candidate.trim();
    return tag === '*' || tag.replace(/^W\//u, '') === etag;
  });
}

/** JSON with object keys sorted, so two orderings of one context share a tag. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const entries: [string, unknown][] = Object.entries(value);
    const members = entries
      .toSorted(byKey)
      .map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`);
    return `{${members.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function byKey([left]: [string, unknown], [right]: [string, unknown]): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
