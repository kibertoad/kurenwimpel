import type { FlagProvider } from '@kurenwimpel/core';
import { createOfrepHandler } from '@kurenwimpel/ofrep-server';
import type { OfrepAuthorization, OfrepHandlerOptions } from '@kurenwimpel/ofrep-server';

import { WorkerFlags } from './worker-flags.js';
import type { WorkerFlagsOptions } from './worker-flags.js';

export interface OfrepWorkerOptions<Env = unknown>
  extends
    Omit<WorkerFlagsOptions, 'provider'>,
    Pick<OfrepHandlerOptions, 'bulkFilter' | 'basePath'> {
  /** A provider, or a factory for one when it needs a binding. Called once per isolate. */
  readonly provider: FlagProvider | ((env: Env) => FlagProvider);
  /** Required: an unauthenticated OFREP endpoint publishes every flag. */
  readonly authorize: (
    request: Request,
    env: Env,
  ) => OfrepAuthorization | Promise<OfrepAuthorization>;
}

export interface OfrepWorker<Env = unknown> {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>;
}

/**
 * A Worker that serves OFREP and nothing else. Export it as the module's
 * default; the ruleset loads on an isolate's first request and refreshes
 * through `ctx.waitUntil` after that.
 */
export function createOfrepWorker<Env = unknown>(
  options: OfrepWorkerOptions<Env>,
): OfrepWorker<Env> {
  const { provider, authorize, bulkFilter, basePath, onError, ...flagsOptions } = options;
  // A failed first load reaches both WorkerFlags and the handler; report it once.
  const reported = new WeakSet<Error>();
  let flags: WorkerFlags | undefined;

  return {
    fetch(request, env, ctx) {
      flags ??= new WorkerFlags({
        ...flagsOptions,
        provider: typeof provider === 'function' ? provider(env) : provider,
        ...(onError === undefined
          ? {}
          : {
              onError: (error: Error) => {
                reported.add(error);
                onError(error);
              },
            }),
      });
      const isolateFlags = flags;

      const handler = createOfrepHandler({
        client: () => isolateFlags.get(ctx),
        authorize: (incoming) => authorize(incoming, env),
        ...(bulkFilter === undefined ? {} : { bulkFilter }),
        ...(basePath === undefined ? {} : { basePath }),
        ...(onError === undefined
          ? {}
          : {
              onError: (error: Error) => {
                if (!reported.has(error)) onError(error);
              },
            }),
      });
      return handler(request);
    },
  };
}
