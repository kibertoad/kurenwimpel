import type { FeatureFlagClient, FlagSnapshot } from '@kurenwimpel/core';
import {
  DEFAULT_INACTIVITY_DELAY_SECONDS,
  OFREP_BASE_PATH,
  REFETCH_EVALUATION_EVENT_TYPE,
  SSE_EVENT_STREAM_TYPE,
} from '@kurenwimpel/ofrep';

import { createChangeFeed } from './change-feed.js';
import type { ChangeFeed } from './change-feed.js';
import type { OfrepEventStreamOptions } from './options.js';
import type { EventStream } from './routes.js';

export const DEFAULT_EVENT_STREAM_PATH = `${OFREP_BASE_PATH}/event-stream`;
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
export const DEFAULT_VERSION_CHECK_INTERVAL_MS = 250;

export interface EventStreamDeps {
  readonly basePath: string;
  readonly client: () => Promise<FeatureFlagClient>;
  readonly onError: ((error: Error) => void) | undefined;
}

export function createEventStream(
  options: OfrepEventStreamOptions,
  deps: EventStreamDeps,
): EventStream {
  const inactivityDelaySec = options.inactivityDelaySec ?? DEFAULT_INACTIVITY_DELAY_SECONDS;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  if (!Number.isInteger(inactivityDelaySec) || inactivityDelaySec < 1) {
    throw new TypeError('eventStream.inactivityDelaySec must be a positive integer');
  }
  if (!(heartbeatIntervalMs > 0 && heartbeatIntervalMs < inactivityDelaySec * 1000)) {
    throw new TypeError('eventStream.heartbeatIntervalMs must be shorter than inactivityDelaySec');
  }

  const path = `${deps.basePath}${options.path ?? DEFAULT_EVENT_STREAM_PATH}`;
  const feed = createChangeFeed({
    client: deps.client,
    intervalMs: options.versionCheckIntervalMs ?? DEFAULT_VERSION_CHECK_INTERVAL_MS,
    onError: deps.onError,
  });

  return {
    route: {
      method: 'GET',
      match: (pathname) => (pathname === path ? {} : undefined),
      handle: (request) => Promise.resolve(openStream(request, feed, heartbeatIntervalMs)),
    },
    advertisement: {
      type: SSE_EVENT_STREAM_TYPE,
      endpoint: { requestUri: path },
      inactivityDelaySec,
    },
  };
}

function openStream(request: Request, feed: ChangeFeed, heartbeatIntervalMs: number): Response {
  const encoder = new TextEncoder();
  const teardown: (() => void)[] = [];
  const release = (): void => {
    for (const step of teardown.splice(0)) step();
  };

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (text: string): void => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          release();
        }
      };
      const unsubscribe = feed.subscribe((snapshot) => {
        send(refetchEvent(snapshot));
      });
      const heartbeat = setInterval(() => {
        send(': heartbeat\n\n');
      }, heartbeatIntervalMs);
      const abort = (): void => {
        release();
        controller.close();
      };

      teardown.push(unsubscribe, () => {
        clearInterval(heartbeat);
        request.signal.removeEventListener('abort', abort);
      });
      request.signal.addEventListener('abort', abort);
      if (request.signal.aborted) {
        abort();
        return;
      }
      // Flushes the response headers through proxies that wait for the first byte.
      send(': connected\n\n');
    },
    cancel() {
      release();
    },
  });

  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
  });
}

/** No `event:` field: an `EventSource` delivers named events only to listeners for that name. */
function refetchEvent(snapshot: FlagSnapshot): string {
  const data = {
    type: REFETCH_EVALUATION_EVENT_TYPE,
    lastModified: Math.floor(snapshot.fetchedAt / 1000),
  };
  return `data: ${JSON.stringify(data)}\n\n`;
}
