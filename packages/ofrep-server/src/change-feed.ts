import type { FeatureFlagClient, FlagSnapshot } from '@kurenwimpel/core';

import { snapshotIdentity } from './etag.js';

export type ChangeListener = (snapshot: FlagSnapshot) => void;

export interface ChangeFeed {
  /** Calls `listener` each time the served snapshot changes. Returns the unsubscribe. */
  subscribe(listener: ChangeListener): () => void;
}

export interface ChangeFeedOptions {
  readonly client: () => Promise<FeatureFlagClient>;
  readonly intervalMs: number;
  readonly onError: ((error: Error) => void) | undefined;
}

/**
 * Notices snapshot swaps on a client that refreshes on its own schedule.
 *
 * The client has no change hook, so the feed compares snapshot identities on a
 * short interval. The timer runs only while at least one listener is subscribed.
 */
export function createChangeFeed(options: ChangeFeedOptions): ChangeFeed {
  const listeners = new Set<ChangeListener>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let seen: string | number | undefined;
  let checking = false;

  async function check(): Promise<void> {
    if (checking) return;
    checking = true;
    try {
      const { snapshot } = await options.client();
      const identity = snapshotIdentity(snapshot);
      const baseline = seen === undefined;
      if (identity === seen) return;
      seen = identity;
      if (!baseline) for (const listener of listeners) listener(snapshot);
    } catch (error) {
      options.onError?.(error instanceof Error ? error : new Error(String(error)));
    } finally {
      checking = false;
    }
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (timer === undefined) {
        void check();
        timer = setInterval(() => void check(), options.intervalMs);
      }

      return () => {
        listeners.delete(listener);
        if (listeners.size > 0 || timer === undefined) return;
        clearInterval(timer);
        timer = undefined;
        seen = undefined;
      };
    },
  };
}
