import { FeatureFlagClient, StaticProvider } from '@kurenwimpel/core';
import type { ImpressionEvent } from '@kurenwimpel/core';
import { describe, expect, it } from 'vitest';

import { evaluateFlag, handlerFor, readyClient } from './support.js';

const context = { targetingKey: 'user-1', country: 'CA' };

describe('POST /ofrep/v1/evaluate/flags/:key', () => {
  it('serves a targeted boolean with its variant, reason and metadata', async () => {
    const handler = handlerFor(await readyClient());

    const response = await evaluateFlag(handler, 'new-checkout', { context });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      key: 'new-checkout',
      value: true,
      variant: 'on',
      reason: 'TARGETING_MATCH',
      metadata: { team: 'payments' },
    });
  });

  it.each([
    ['theme', 'dark', 'STATIC'],
    ['max-items', 10, 'STATIC'],
    ['ratio', 0.5, 'STATIC'],
    ['banner', { text: '' }, 'DISABLED'],
  ])('serves %s in its natural JSON type', async (key, value, reason) => {
    const handler = handlerFor(await readyClient());

    const response = await evaluateFlag(handler, key, { context });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ key, value, reason });
  });

  it('keeps rule ids and other targeting detail off the wire', async () => {
    const handler = handlerFor(await readyClient());

    const response = await evaluateFlag(handler, 'new-checkout', { context });

    expect(response.body).not.toHaveProperty('ruleId');
  });

  it('answers 404 with a flagNotFound body for an unknown key', async () => {
    const handler = handlerFor(await readyClient());

    const response = await evaluateFlag(handler, 'nope', { context });

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ key: 'nope', errorCode: 'FLAG_NOT_FOUND' });
  });

  it('answers 400 with an evaluationFailure for a flag that cannot be evaluated', async () => {
    const handler = handlerFor(await readyClient());

    const response = await evaluateFlag(handler, 'broken', { context });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ key: 'broken', errorCode: 'GENERAL' });
  });

  it('reports a missing bucketing attribute as TARGETING_KEY_MISSING', async () => {
    const handler = handlerFor(await readyClient());

    const response = await evaluateFlag(handler, 'experiment', { context });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ key: 'experiment', errorCode: 'TARGETING_KEY_MISSING' });
  });

  it('decodes a percent-encoded key', async () => {
    const handler = handlerFor(await readyClient());

    const response = await evaluateFlag(handler, 'a/b c', { context });

    expect(response.body).toMatchObject({ key: 'a/b c', errorCode: 'FLAG_NOT_FOUND' });
  });

  it('answers PARSE_ERROR for a key that is not valid percent-encoding', async () => {
    const handler = handlerFor(await readyClient());

    const response = await evaluateFlag(
      handler,
      '',
      { context },
      { path: '/ofrep/v1/evaluate/flags/%E0%A4%A' },
    );

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ key: '%E0%A4%A', errorCode: 'PARSE_ERROR' });
  });

  it.each([
    ['a body that is not JSON', '{', 'PARSE_ERROR'],
    ['a body without a context', {}, 'INVALID_CONTEXT'],
    ['a context that is not an object', { context: 'user-1' }, 'INVALID_CONTEXT'],
    ['a context without a targetingKey', { context: { country: 'CA' } }, 'TARGETING_KEY_MISSING'],
    ['a numeric targetingKey', { context: { targetingKey: 7 } }, 'TARGETING_KEY_MISSING'],
  ])('answers 400 for %s', async (_, body, errorCode) => {
    const handler = handlerFor(await readyClient());

    const response = await evaluateFlag(handler, 'theme', body);

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ key: 'theme', errorCode });
  });

  it('answers 500 before the client has loaded', async () => {
    const client = new FeatureFlagClient({ provider: new StaticProvider([]) });
    const handler = handlerFor(client);

    const response = await evaluateFlag(handler, 'theme', { context });

    expect(response.status).toBe(500);
  });

  it('emits an impression, because a single evaluation is an exposure', async () => {
    const impressions: ImpressionEvent[] = [];
    const handler = handlerFor(
      await readyClient({ onImpression: (event) => impressions.push(event) }),
    );

    await evaluateFlag(handler, 'new-checkout', { context });

    expect(impressions).toHaveLength(1);
    expect(impressions[0]).toMatchObject({ flagKey: 'new-checkout', targetingKey: 'user-1' });
  });

  it('serves flags the bulk filter excludes', async () => {
    const handler = handlerFor(await readyClient(), { bulkFilter: () => false });

    const response = await evaluateFlag(handler, 'server-only', { context });

    expect(response.status).toBe(200);
  });
});
