import {
  DEFAULT_FLAGS_KEY,
  DEFAULT_REVISION_PREFIX,
  revisionKey,
} from '@kurenwimpel/cloudflare/kv-layout';
import type { KvFlagMetadata, KvRevisionMetadata } from '@kurenwimpel/cloudflare/kv-layout';

import { DEFAULT_KEEP } from '../config/types.js';
import type { KvTargetConfig } from '../config/types.js';
import { isRecord } from '../json.js';
import { KvApi } from './cloudflare-api.js';
import type { KvKey } from './cloudflare-api.js';
import { MIB, requireEnv, revisionsToPrune } from './target.js';
import type { PublishedRevision, PublishTarget, StoredRevision, TargetDeps } from './target.js';

/** The Workers KV limit on one value. */
export const KV_MAX_VALUE_BYTES = 25 * MIB;

/**
 * Publishes in the layout `KvFlagProvider` reads: the document goes to
 * `<prefix><revision>` first, then to the current key with `{ revision }` as
 * metadata, so a reader never sees a current key whose revision is not stored.
 */
export function kvTarget(config: KvTargetConfig, deps: TargetDeps): PublishTarget {
  const accountId = config.accountId ?? requireEnv(deps, 'CLOUDFLARE_ACCOUNT_ID', 'kv target');
  const api = new KvApi(deps, {
    accountId,
    namespaceId: config.namespaceId,
    tokenEnv: config.apiTokenEnv ?? 'CLOUDFLARE_API_TOKEN',
  });
  const currentKey = config.key ?? DEFAULT_FLAGS_KEY;
  const prefix = config.revisionPrefix ?? DEFAULT_REVISION_PREFIX;
  const keep = config.keep ?? DEFAULT_KEEP;

  const list = async (): Promise<StoredRevision[]> =>
    (await api.list(prefix)).map((key) => storedRevision(key, prefix));

  const pointAt = async (revision: string, payload: string): Promise<void> => {
    const metadata: KvFlagMetadata = { revision };
    await api.put(currentKey, payload, metadata);
  };

  return {
    description: `kv namespace ${config.namespaceId} key ${currentKey}`,
    maxPayloadBytes: KV_MAX_VALUE_BYTES,
    async currentRevision() {
      return revisionIn(await api.metadata(currentKey));
    },
    async write({ revision, payload, publishedAt }: PublishedRevision) {
      const metadata: KvRevisionMetadata = { revision, publishedAt };
      await api.put(revisionKey(revision, prefix), payload, metadata);
      await pointAt(revision, payload);

      const stale = revisionsToPrune(await list(), revision, keep);
      await api.deleteMany(stale.map((entry) => revisionKey(entry.revision, prefix)));
    },
    revisions: {
      list,
      async activate(revision) {
        const payload = await api.get(revisionKey(revision, prefix));
        if (payload === undefined) throw new Error(`revision ${revision} is not stored`);
        await pointAt(revision, payload);
      },
    },
  };
}

function storedRevision(key: KvKey, prefix: string): StoredRevision {
  return {
    revision: key.name.slice(prefix.length),
    publishedAt: stringField(key.metadata, 'publishedAt'),
  };
}

function revisionIn(metadata: unknown): string | undefined {
  return stringField(metadata, 'revision');
}

function stringField(metadata: unknown, name: string): string | undefined {
  const value = isRecord(metadata) ? metadata[name] : undefined;
  return typeof value === 'string' ? value : undefined;
}
