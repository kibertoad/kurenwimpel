import { FeatureFlagClient, StaticProvider } from '@kurenwimpel/core';
import type { FlagDefinition, FeatureFlagClientOptions } from '@kurenwimpel/core';
import {
  evaluateFlagContract,
  evaluateFlagsBulkContract,
  ofrepResponseHeadersSchema,
} from '@kurenwimpel/ofrep';
import { isNoBodyResponse, resolveStatusEntry } from '@toad-contracts/core';
import type { ApiContractResponse } from '@toad-contracts/core';
import { expect } from 'vitest';
import * as z from 'zod/mini';

import { createOfrepHandler } from '../src/index.js';
import type { OfrepHandler, OfrepHandlerOptions } from '../src/index.js';

export const FLAGS: FlagDefinition[] = [
  {
    key: 'new-checkout',
    enabled: true,
    variants: { on: true, off: false },
    defaultVariant: 'off',
    offVariant: 'off',
    rules: [
      {
        id: 'canada',
        conditions: [{ attribute: 'country', operator: 'eq', value: 'CA' }],
        variant: 'on',
      },
    ],
    metadata: { team: 'payments' },
  },
  {
    key: 'theme',
    enabled: true,
    variants: { light: 'light', dark: 'dark' },
    defaultVariant: 'dark',
    offVariant: 'light',
  },
  {
    key: 'max-items',
    enabled: true,
    variants: { small: 10, large: 100 },
    defaultVariant: 'small',
    offVariant: 'small',
  },
  {
    key: 'ratio',
    enabled: true,
    variants: { half: 0.5 },
    defaultVariant: 'half',
    offVariant: 'half',
  },
  {
    key: 'banner',
    enabled: false,
    variants: { shown: { text: 'hi' }, hidden: { text: '' } },
    defaultVariant: 'shown',
    offVariant: 'hidden',
  },
  {
    key: 'experiment',
    enabled: true,
    variants: { a: 'a', b: 'b' },
    defaultVariant: 'a',
    offVariant: 'a',
    rollout: {
      buckets: [
        { variant: 'a', weight: 50 },
        { variant: 'b', weight: 50 },
      ],
      bucketBy: 'accountId',
    },
  },
  {
    key: 'broken',
    enabled: true,
    variants: { on: true },
    defaultVariant: 'missing',
    offVariant: 'on',
  },
  {
    key: 'server-only',
    enabled: true,
    variants: { on: true },
    defaultVariant: 'on',
    offVariant: 'on',
    metadata: { audience: 'server' },
  },
];

export const ORIGIN = 'http://flags.test';

export async function readyClient(
  options: Partial<FeatureFlagClientOptions> = {},
  version = 'v1',
): Promise<FeatureFlagClient> {
  const client = new FeatureFlagClient({
    provider: new StaticProvider(FLAGS, { version }),
    ...options,
  });
  await client.init();
  return client;
}

export function handlerFor(
  client: FeatureFlagClient,
  options: Partial<OfrepHandlerOptions> = {},
): OfrepHandler {
  return createOfrepHandler({ client: () => client, authorize: () => true, ...options });
}

export interface CheckedResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: unknown;
}

/** Validates a response against the route's contract: status, headers and body. */
export async function checked(
  responses: Partial<Record<number | string, ApiContractResponse>>,
  response: Response,
): Promise<CheckedResponse> {
  const entry = resolveStatusEntry(responses, response.status);
  expect(entry, `status ${response.status} is not in the contract`).toBeDefined();
  expect(
    z.safeParse(ofrepResponseHeadersSchema, Object.fromEntries(response.headers)).success,
  ).toBe(true);

  if (entry === undefined || isNoBodyResponse(entry) || typeof entry === 'symbol') {
    expect(await response.text()).toBe('');
    return { status: response.status, headers: response.headers, body: undefined };
  }

  expect(response.headers.get('content-type')).toBe('application/json');
  const body: unknown = await response.json();
  const result = await (entry as z.ZodMiniType)['~standard'].validate(body);
  expect(result.issues, JSON.stringify(body)).toBeUndefined();
  return { status: response.status, headers: response.headers, body };
}

interface CallOptions {
  readonly headers?: Record<string, string>;
  readonly path?: string;
}

export async function evaluateFlag(
  handler: OfrepHandler,
  key: string,
  body: unknown,
  options: CallOptions = {},
): Promise<CheckedResponse> {
  const path = options.path ?? `/ofrep/v1/evaluate/flags/${encodeURIComponent(key)}`;
  const response = await handler(post(path, body, options.headers));
  return checked(evaluateFlagContract.responsesByStatusCode, response);
}

export async function evaluateBulk(
  handler: OfrepHandler,
  body: unknown,
  options: CallOptions = {},
): Promise<CheckedResponse> {
  const response = await handler(
    post(options.path ?? '/ofrep/v1/evaluate/flags', body, options.headers),
  );
  return checked(evaluateFlagsBulkContract.responsesByStatusCode, response);
}

export function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
