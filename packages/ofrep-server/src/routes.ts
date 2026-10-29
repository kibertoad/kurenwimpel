import type { FeatureFlagClient, FlagDefinition } from '@kurenwimpel/core';
import { OFREP_EVALUATE_PATH } from '@kurenwimpel/ofrep';

import { bulkEtag, matchesEtag } from './etag.js';
import { readContext } from './request-body.js';
import { emptyResponse, jsonResponse, serverError } from './responses.js';
import { statusOf, toOfrepEntry } from './results.js';

export interface RouteDeps {
  readonly client: () => Promise<FeatureFlagClient>;
  readonly bulkFilter: ((flag: FlagDefinition) => boolean) | undefined;
}

/**
 * One path the handler serves. The handler matches the path first, then checks
 * the method and authorization, and only then calls `handle`.
 */
export interface OfrepRoute {
  readonly method: string;
  /** Path parameters when `pathname` addresses this route, otherwise `undefined`. */
  match(pathname: string): Readonly<Record<string, string>> | undefined;
  handle(request: Request, params: Readonly<Record<string, string>>): Promise<Response>;
}

export function buildRoutes(basePath: string, deps: RouteDeps): OfrepRoute[] {
  return [bulkRoute(`${basePath}${OFREP_EVALUATE_PATH}`, deps), flagRoute(basePath, deps)];
}

function flagRoute(basePath: string, deps: RouteDeps): OfrepRoute {
  const prefix = `${basePath}${OFREP_EVALUATE_PATH}/`;
  return {
    method: 'POST',
    match(pathname) {
      const key = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : '';
      return key === '' ? undefined : { key };
    },
    async handle(request, params) {
      const raw = params['key'] ?? '';
      const key = decodeKey(raw);
      if (key === undefined) {
        return jsonResponse(400, {
          key: raw,
          errorCode: 'PARSE_ERROR',
          errorDetails: 'Malformed key',
        });
      }

      const body = await readContext(request);
      if (!body.ok) {
        return jsonResponse(400, {
          key,
          errorCode: body.errorCode,
          errorDetails: body.errorDetails,
        });
      }

      const client = await deps.client();
      if (!client.ready) return notReady();

      const entry = toOfrepEntry(client.evaluate(key, body.context));
      return jsonResponse(statusOf(entry), entry);
    },
  };
}

function bulkRoute(path: string, deps: RouteDeps): OfrepRoute {
  return {
    method: 'POST',
    match: (pathname) => (pathname === path ? {} : undefined),
    async handle(request) {
      const body = await readContext(request);
      if (!body.ok) {
        return jsonResponse(400, { errorCode: body.errorCode, errorDetails: body.errorDetails });
      }

      const client = await deps.client();
      // evaluateAll throws here, and an empty list would read as "no flags".
      if (!client.ready) return notReady();

      const etag = await bulkEtag(client.snapshot, body.context);
      if (matchesEtag(request.headers.get('if-none-match'), etag)) {
        return emptyResponse(304, { etag });
      }

      const { bulkFilter } = deps;
      const { flags } = client.snapshot;
      const results = client.evaluateAll(body.context).filter((result) => {
        if (bulkFilter === undefined) return true;
        const flag = flags.get(result.key);
        return flag !== undefined && bulkFilter(flag);
      });

      return jsonResponse(200, { flags: results.map((result) => toOfrepEntry(result)) }, { etag });
    },
  };
}

function notReady(): Response {
  return serverError('Flags have not been loaded yet');
}

function decodeKey(raw: string): string | undefined {
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
}
