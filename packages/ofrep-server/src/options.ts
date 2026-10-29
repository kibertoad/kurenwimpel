import type { FeatureFlagClient, FlagDefinition } from '@kurenwimpel/core';

/**
 * Turns a request away. A bare `false` from `authorize` is a 401.
 *
 * `retryAfter` is seconds as a number, or a `Date` sent as an HTTP-date.
 */
export type OfrepRejection =
  | { readonly status: 401 | 403 }
  | { readonly status: 429; readonly retryAfter?: number | Date };

export type OfrepAuthorization = boolean | OfrepRejection;

export interface OfrepHandlerOptions {
  /** The client to evaluate with. Awaited once per request. */
  readonly client: () => FeatureFlagClient | Promise<FeatureFlagClient>;
  /**
   * Decides whether a request may evaluate flags. Required: an open OFREP
   * endpoint publishes every flag, its variants and its metadata.
   */
  readonly authorize: (request: Request) => OfrepAuthorization | Promise<OfrepAuthorization>;
  /**
   * Keeps flags out of the bulk route, which client-side SDKs call. Return
   * `false` for server-only flags. The single-flag route ignores it.
   */
  readonly bulkFilter?: (flag: FlagDefinition) => boolean;
  /** Prefix in front of `/ofrep/v1`, for a handler mounted below the root. */
  readonly basePath?: string;
  /**
   * Receives every error that became a 500, and failures reading the client
   * while change streams are open. The response body never carries it.
   */
  readonly onError?: (error: Error) => void;
  /** Serves an SSE change stream and advertises it in bulk responses. Off when absent. */
  readonly eventStream?: OfrepEventStreamOptions;
}

export interface OfrepEventStreamOptions {
  /** Path of the SSE route, below `basePath`. Defaults to `/ofrep/v1/event-stream`. */
  readonly path?: string;
  /** Advertised to providers as `inactivityDelaySec`. Defaults to 120. */
  readonly inactivityDelaySec?: number;
  /** Gap between comment heartbeats; shorter than `inactivityDelaySec`. Defaults to 30 s. */
  readonly heartbeatIntervalMs?: number;
  /** How often an open stream compares the client's snapshot version. Defaults to 250 ms. */
  readonly versionCheckIntervalMs?: number;
}

export type OfrepHandler = (request: Request) => Promise<Response>;
