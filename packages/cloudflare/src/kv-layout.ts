/**
 * The Workers KV key layout shared by `KvFlagProvider` (the reader) and the
 * `kurenwimpel publish` kv target (the writer).
 *
 * Publishing writes the document under {@link revisionKey} first, then copies
 * it to {@link DEFAULT_FLAGS_KEY} with {@link KvFlagMetadata}. A rollback copies
 * a stored revision back onto the current key. Readers only ever read the
 * current key.
 *
 * This module has no runtime dependencies and no Workers types, so tools that
 * write KV through the REST API can import it from
 * `@kurenwimpel/cloudflare/kv-layout`.
 */

/** The key the provider reads by default. */
export const DEFAULT_FLAGS_KEY = 'flags:current';

/** Prefix of the keys holding each published revision. */
export const DEFAULT_REVISION_PREFIX = 'flags:rev:';

/** Metadata stamped on the current key. The provider skips re-parsing an unchanged `revision`. */
export interface KvFlagMetadata {
  readonly revision?: string;
}

/** Metadata stamped on each revision key. `publishedAt` is an ISO 8601 timestamp. */
export interface KvRevisionMetadata {
  readonly revision: string;
  readonly publishedAt: string;
}

export function revisionKey(revision: string, prefix: string = DEFAULT_REVISION_PREFIX): string {
  return `${prefix}${revision}`;
}
