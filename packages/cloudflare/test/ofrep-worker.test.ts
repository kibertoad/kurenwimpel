import {
  bulkEvaluationSuccessSchema,
  evaluationFailureSchema,
  flagNotFoundSchema,
  generalErrorResponseSchema,
  serverEvaluationSuccessSchema,
} from '@kurenwimpel/ofrep';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod/mini';

import { createOfrepWorker, DEFAULT_FLAGS_KEY, KvFlagProvider } from '../src/index.js';
import type { FlagDefinition, OfrepWorker } from '../src/index.js';

const ruleset: FlagDefinition[] = [
  {
    key: 'new-checkout',
    enabled: true,
    variants: { on: true, off: false },
    defaultVariant: 'on',
    offVariant: 'off',
  },
  {
    key: 'internal',
    enabled: true,
    variants: { on: true },
    defaultVariant: 'on',
    offVariant: 'on',
    metadata: { audience: 'server' },
  },
];

const SCHEMAS: Record<number, z.ZodMiniType> = {
  200: z.union([serverEvaluationSuccessSchema, bulkEvaluationSuccessSchema]),
  400: evaluationFailureSchema,
  404: flagNotFoundSchema,
  500: generalErrorResponseSchema,
};

type Env = typeof env;

function worker(onError?: (error: Error) => void): OfrepWorker<Env> {
  return createOfrepWorker<Env>({
    provider: (bindings) => new KvFlagProvider({ namespace: bindings.FLAGS }),
    authorize: (request) => request.headers.get('x-api-key') === 'secret',
    bulkFilter: (flag) => flag.metadata?.['audience'] !== 'server',
    ...(onError === undefined ? {} : { onError }),
  });
}

async function call(target: OfrepWorker<Env>, path: string, apiKey = 'secret') {
  const request = new Request(`https://flags.example${path}`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ context: { targetingKey: 'user-1' } }),
  });
  const ctx = createExecutionContext();
  const response = await target.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);

  const text = await response.text();
  const schema = SCHEMAS[response.status];
  const body: unknown = text === '' ? undefined : JSON.parse(text);
  if (schema === undefined) expect(text).toBe('');
  else expect(z.safeParse(schema, body).success, text).toBe(true);
  return { status: response.status, body };
}

beforeEach(async () => {
  const { keys } = await env.FLAGS.list();
  await Promise.all(keys.map((entry) => env.FLAGS.delete(entry.name)));
});

describe('createOfrepWorker', () => {
  it('serves a single flag from KV', async () => {
    await env.FLAGS.put(DEFAULT_FLAGS_KEY, JSON.stringify(ruleset));

    const response = await call(worker(), '/ofrep/v1/evaluate/flags/new-checkout');

    expect(response).toEqual({
      status: 200,
      body: { key: 'new-checkout', value: true, variant: 'on', reason: 'STATIC' },
    });
  });

  it('serves the bulk route through bulkFilter', async () => {
    await env.FLAGS.put(DEFAULT_FLAGS_KEY, JSON.stringify(ruleset));

    const response = await call(worker(), '/ofrep/v1/evaluate/flags');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      flags: [{ key: 'new-checkout', value: true, variant: 'on', reason: 'STATIC' }],
    });
  });

  it('rejects a request authorize turns away', async () => {
    await env.FLAGS.put(DEFAULT_FLAGS_KEY, JSON.stringify(ruleset));

    const response = await call(worker(), '/ofrep/v1/evaluate/flags', 'wrong');

    expect(response.status).toBe(401);
  });

  it('answers 500 and reports the failure once when KV holds no ruleset', async () => {
    const onError = vi.fn();

    const response = await call(worker(onError), '/ofrep/v1/evaluate/flags');

    expect(response.status).toBe(500);
    expect(onError).toHaveBeenCalledOnce();
  });

  it('loads once per isolate and serves later requests from memory', async () => {
    await env.FLAGS.put(DEFAULT_FLAGS_KEY, JSON.stringify(ruleset));
    const target = worker();
    await call(target, '/ofrep/v1/evaluate/flags');
    await env.FLAGS.delete(DEFAULT_FLAGS_KEY);

    const response = await call(target, '/ofrep/v1/evaluate/flags/new-checkout');

    expect(response.status).toBe(200);
  });
});
