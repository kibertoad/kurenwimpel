import { FeatureFlagClient, StaticProvider } from '@kurenwimpel/core';
import type { ImpressionEvent } from '@kurenwimpel/core';
import { describe, expect, it } from 'vitest';

import { evaluateBulk, FLAGS, handlerFor, readyClient } from './support.js';

const context = { targetingKey: 'user-1', country: 'CA' };

interface BulkBody {
  readonly flags: readonly { readonly key: string }[];
}

function keysOf(body: unknown): string[] {
  return (body as BulkBody).flags.map((flag) => flag.key);
}

describe('POST /ofrep/v1/evaluate/flags', () => {
  it('evaluates every flag, failures included, under one 200', async () => {
    const handler = handlerFor(await readyClient());

    const response = await evaluateBulk(handler, { context });

    expect(response.status).toBe(200);
    expect(keysOf(response.body)).toEqual(FLAGS.map((flag) => flag.key));
    expect((response.body as BulkBody).flags).toContainEqual({
      key: 'new-checkout',
      value: true,
      variant: 'on',
      reason: 'TARGETING_MATCH',
      metadata: { team: 'payments' },
    });
    expect((response.body as BulkBody).flags).toContainEqual(
      expect.objectContaining({ key: 'broken', errorCode: 'GENERAL' }),
    );
  });

  it('leaves out the flags bulkFilter rejects', async () => {
    const handler = handlerFor(await readyClient(), {
      bulkFilter: (flag) => flag.metadata?.['audience'] !== 'server',
    });

    const response = await evaluateBulk(handler, { context });

    expect(keysOf(response.body)).not.toContain('server-only');
    expect(keysOf(response.body)).toHaveLength(FLAGS.length - 1);
  });

  it('emits no impressions, because a bulk fetch is not an exposure', async () => {
    const impressions: ImpressionEvent[] = [];
    const handler = handlerFor(
      await readyClient({ onImpression: (event) => impressions.push(event) }),
    );

    await evaluateBulk(handler, { context });

    expect(impressions).toEqual([]);
  });

  it('answers 500 rather than an empty list before the client has loaded', async () => {
    const client = new FeatureFlagClient({ provider: new StaticProvider([]) });
    const handler = handlerFor(client);

    const response = await evaluateBulk(handler, { context });

    expect(response.status).toBe(500);
  });

  it.each([
    ['a body that is not JSON', 'nope', 'PARSE_ERROR'],
    ['a body without a context', { ctx: {} }, 'INVALID_CONTEXT'],
    ['a context without a targetingKey', { context: {} }, 'TARGETING_KEY_MISSING'],
  ])('answers 400 with a bulkEvaluationFailure for %s', async (_, body, errorCode) => {
    const handler = handlerFor(await readyClient());

    const response = await evaluateBulk(handler, body);

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ errorCode });
  });
});

describe('bulk ETag', () => {
  it('answers 304 with no body for the ETag it just served', async () => {
    const handler = handlerFor(await readyClient());
    const first = await evaluateBulk(handler, { context });
    const etag = first.headers.get('etag') ?? '';

    const second = await evaluateBulk(handler, { context }, { headers: { 'if-none-match': etag } });

    expect(etag).toMatch(/^"[0-9a-f]{32}"$/u);
    expect(second.status).toBe(304);
    expect(second.headers.get('etag')).toBe(etag);
  });

  it('matches a weak tag and a tag inside a list', async () => {
    const handler = handlerFor(await readyClient());
    const etag = (await evaluateBulk(handler, { context })).headers.get('etag') ?? '';

    const weak = await evaluateBulk(
      handler,
      { context },
      { headers: { 'if-none-match': `W/${etag}` } },
    );
    const listed = await evaluateBulk(
      handler,
      { context },
      { headers: { 'if-none-match': `"x", ${etag}` } },
    );

    expect(weak.status).toBe(304);
    expect(listed.status).toBe(304);
  });

  it('ignores the order of context keys', async () => {
    const handler = handlerFor(await readyClient());
    const first = await evaluateBulk(handler, {
      context: { targetingKey: 'u', a: 1, b: { y: 1, x: 2 } },
    });
    const second = await evaluateBulk(handler, {
      context: { b: { x: 2, y: 1 }, a: 1, targetingKey: 'u' },
    });

    expect(second.headers.get('etag')).toBe(first.headers.get('etag'));
  });

  it('changes with the context', async () => {
    const handler = handlerFor(await readyClient());
    const etag = (await evaluateBulk(handler, { context })).headers.get('etag') ?? '';

    const other = await evaluateBulk(
      handler,
      { context: { ...context, country: 'US' } },
      { headers: { 'if-none-match': etag } },
    );

    expect(other.status).toBe(200);
    expect(other.headers.get('etag')).not.toBe(etag);
  });

  it('changes when a new snapshot version is installed', async () => {
    const provider = new StaticProvider(FLAGS, { version: 'v1' });
    const client = new FeatureFlagClient({ provider });
    await client.init();
    const handler = handlerFor(client);
    const etag = (await evaluateBulk(handler, { context })).headers.get('etag') ?? '';

    provider.replace(FLAGS, { version: 'v2' });
    await client.refresh();
    const after = await evaluateBulk(handler, { context }, { headers: { 'if-none-match': etag } });

    expect(after.status).toBe(200);
  });

  it('falls back to the load time when the snapshot carries no version', async () => {
    const first = new FeatureFlagClient({ provider: new StaticProvider(FLAGS, { fetchedAt: 1 }) });
    const second = new FeatureFlagClient({ provider: new StaticProvider(FLAGS, { fetchedAt: 2 }) });
    await Promise.all([first.init(), second.init()]);

    const one = await evaluateBulk(handlerFor(first), { context });
    const two = await evaluateBulk(handlerFor(second), { context });

    expect(one.headers.get('etag')).not.toBe(two.headers.get('etag'));
  });
});
