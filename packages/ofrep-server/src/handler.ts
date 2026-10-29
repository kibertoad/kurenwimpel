import type { FeatureFlagClient } from '@kurenwimpel/core';

import type { OfrepAuthorization, OfrepHandler, OfrepHandlerOptions } from './options.js';
import { emptyResponse, rejectionResponse, serverError } from './responses.js';
import { buildRoutes } from './routes.js';
import type { OfrepRoute } from './routes.js';
import { createEventStream } from './stream-route.js';

/**
 * Serves both OFREP evaluation routes, and the change stream when configured,
 * from one Fetch API handler, so it runs unchanged on Workers, Node (behind any
 * Fetch adapter) and Bun.
 *
 * Paths it does not own answer 404 with no body, so it can sit behind a router
 * or be the whole server.
 */
export function createOfrepHandler(options: OfrepHandlerOptions): OfrepHandler {
  if (typeof options.authorize !== 'function') {
    throw new TypeError('createOfrepHandler requires an authorize function');
  }

  const { authorize, onError } = options;
  const basePath = trimTrailingSlash(options.basePath ?? '');
  const client = (): Promise<FeatureFlagClient> => Promise.resolve(options.client());
  const eventStream =
    options.eventStream === undefined
      ? undefined
      : createEventStream(options.eventStream, { basePath, client, onError });
  const routes = buildRoutes(basePath, { client, bulkFilter: options.bulkFilter, eventStream });

  return async (request) => {
    try {
      return await dispatch(routes, request, authorize);
    } catch (error) {
      onError?.(error instanceof Error ? error : new Error(String(error)));
      return serverError('Internal server error');
    }
  };
}

async function dispatch(
  routes: readonly OfrepRoute[],
  request: Request,
  authorize: OfrepHandlerOptions['authorize'],
): Promise<Response> {
  const { pathname } = new URL(request.url);

  const matched = matchRoute(routes, pathname);
  if (matched === undefined) return emptyResponse(404);

  const { route, params } = matched;
  if (request.method !== route.method) return emptyResponse(405, { allow: route.method });

  const rejection = toRejection(await authorize(request));
  if (rejection !== undefined) return rejection;

  return route.handle(request, params);
}

interface RouteMatch {
  readonly route: OfrepRoute;
  readonly params: Readonly<Record<string, string>>;
}

function matchRoute(routes: readonly OfrepRoute[], pathname: string): RouteMatch | undefined {
  for (const route of routes) {
    const params = route.match(pathname);
    if (params !== undefined) return { route, params };
  }
  return undefined;
}

function toRejection(outcome: OfrepAuthorization): Response | undefined {
  if (outcome === true) return undefined;
  return rejectionResponse(outcome === false ? { status: 401 } : outcome);
}

function trimTrailingSlash(path: string): string {
  return path.endsWith('/') ? path.slice(0, -1) : path;
}
