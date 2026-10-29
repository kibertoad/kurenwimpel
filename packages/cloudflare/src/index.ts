/**
 * @kurenwimpel/cloudflare: Workers service wrapper.
 *
 * Supplies a Workers KV backed FlagProvider and an isolate-scoped client that
 * refreshes through `ctx.waitUntil`. Evaluation itself lives in
 * `@kurenwimpel/core`, which this package re-exports for convenience.
 */

export { DEFAULT_FLAGS_KEY, DEFAULT_REVISION_PREFIX, revisionKey } from './kv-layout.js';
export type { KvFlagMetadata, KvRevisionMetadata } from './kv-layout.js';
export { KvFlagProvider } from './kv-provider.js';
export type { KvProviderOptions } from './kv-provider.js';

export { DEFAULT_REFRESH_INTERVAL_MS, WorkerFlags } from './worker-flags.js';
export type { WorkerFlagsOptions } from './worker-flags.js';

export * from '@kurenwimpel/core';
