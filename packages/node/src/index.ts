/**
 * @kurenwimpel/node - Node.js service wrapper.
 *
 * Supplies file and HTTP backed FlagProviders plus a polling client for
 * long-lived processes. Evaluation itself lives in `@kurenwimpel/core`, which
 * this package re-exports for convenience.
 */

export { FileFlagProvider } from './file-provider.js';
export type { FileProviderOptions } from './file-provider.js';

export { DEFAULT_HTTP_TIMEOUT_MS, HttpFlagProvider } from './http-provider.js';
export type { HttpProviderOptions } from './http-provider.js';

export { DEFAULT_POLL_INTERVAL_MS, PollingFlagClient } from './polling-client.js';
export type { PollingClientErrorInfo, PollingFlagClientOptions } from './polling-client.js';

export {
  DEFAULT_MAX_RECONNECT_DELAY_MS,
  DEFAULT_POLL_INTERVAL_MULTIPLIER,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
} from './change-stream.js';
export type { ChangeStreamOptions } from './change-stream.js';

export * from '@kurenwimpel/core';
