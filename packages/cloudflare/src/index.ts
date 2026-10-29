/**
 * @kurenwimpel/cloudflare - Workers service wrapper.
 *
 * Supplies a Workers KV backed FlagProvider, an isolate-scoped client that
 * refreshes through `ctx.waitUntil`, and a Worker that serves OFREP. Evaluation
 * itself lives in `@kurenwimpel/core`, which this package re-exports for convenience.
 */

export { DEFAULT_FLAGS_KEY, KvFlagProvider } from './kv-provider.js';
export type { KvFlagMetadata, KvProviderOptions } from './kv-provider.js';

export { createOfrepWorker } from './ofrep-worker.js';
export type { OfrepWorker, OfrepWorkerOptions } from './ofrep-worker.js';
export type { OfrepAuthorization, OfrepRejection } from '@kurenwimpel/ofrep-server';

export { DEFAULT_REFRESH_INTERVAL_MS, WorkerFlags } from './worker-flags.js';
export type { WorkerFlagsOptions } from './worker-flags.js';

export * from '@kurenwimpel/core';
