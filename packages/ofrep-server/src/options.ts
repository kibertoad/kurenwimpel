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
  /** Receives every error that became a 500. The response body never carries it. */
  readonly onError?: (error: Error) => void;
}

export type OfrepHandler = (request: Request) => Promise<Response>;
