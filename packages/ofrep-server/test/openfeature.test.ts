import { OFREPProvider } from '@openfeature/ofrep-provider';
import { ErrorCode, OpenFeature } from '@openfeature/server-sdk';
import type { Client } from '@openfeature/server-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createOfrepHandler } from '../src/index.js';
import { listen } from './node-server.js';
import type { RunningServer } from './node-server.js';
import { readyClient } from './support.js';

const TOKEN = 'Bearer test-token';
const context = { targetingKey: 'user-1', country: 'CA' };

let server: RunningServer;

async function openFeatureClient(domain: string, authorization: string): Promise<Client> {
  const provider = new OFREPProvider({
    baseUrl: server.url,
    headers: [['authorization', authorization]],
  });
  await OpenFeature.setProviderAndWait(domain, provider);
  return OpenFeature.getClient(domain);
}

beforeAll(async () => {
  const client = await readyClient();
  server = await listen(
    createOfrepHandler({
      client: () => client,
      authorize: (request) => request.headers.get('authorization') === TOKEN,
    }),
  );
});

afterAll(async () => {
  await OpenFeature.close();
  await server.close();
});

// The OpenFeature OFREP provider for Node, over a real socket.
describe('@openfeature/ofrep-provider against the handler', () => {
  it('resolves a targeted boolean with its variant, reason and metadata', async () => {
    const flags = await openFeatureClient('booleans', TOKEN);

    const details = await flags.getBooleanDetails('new-checkout', false, context);

    expect(details).toMatchObject({
      value: true,
      variant: 'on',
      reason: 'TARGETING_MATCH',
      flagMetadata: { team: 'payments' },
    });
    expect(details.errorCode).toBeUndefined();
  });

  it('resolves strings, numbers and objects', async () => {
    const flags = await openFeatureClient('types', TOKEN);

    expect(await flags.getStringValue('theme', 'light', context)).toBe('dark');
    expect(await flags.getNumberValue('max-items', 0, context)).toBe(10);
    expect(await flags.getNumberValue('ratio', 0, context)).toBe(0.5);
    expect(await flags.getObjectValue('banner', {}, context)).toEqual({ text: '' });
  });

  it('falls back to the default for an unknown flag', async () => {
    const flags = await openFeatureClient('missing', TOKEN);

    const details = await flags.getBooleanDetails('nope', true, context);

    expect(details).toMatchObject({ value: true, errorCode: ErrorCode.FLAG_NOT_FOUND });
  });

  it('carries an evaluation error code through to the SDK', async () => {
    const flags = await openFeatureClient('errors', TOKEN);

    const details = await flags.getStringDetails('experiment', 'z', context);

    expect(details).toMatchObject({ value: 'z', errorCode: ErrorCode.TARGETING_KEY_MISSING });
  });

  it('reports a type mismatch on the SDK side', async () => {
    const flags = await openFeatureClient('mismatch', TOKEN);

    const details = await flags.getBooleanDetails('theme', false, context);

    expect(details).toMatchObject({ value: false, errorCode: ErrorCode.TYPE_MISMATCH });
  });

  it('serves defaults to a client the handler does not authorize', async () => {
    const flags = await openFeatureClient('unauthorized', 'Bearer wrong');

    const details = await flags.getBooleanDetails('new-checkout', false, context);

    expect(details.value).toBe(false);
    expect(details.errorCode).toBeDefined();
  });
});
