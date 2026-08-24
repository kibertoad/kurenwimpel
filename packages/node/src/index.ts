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
export type { PollingFlagClientOptions } from './polling-client.js';

export * from '@kurenwimpel/core';
