import { describe, expect, it, vi } from 'vitest';

import { createOfrepHandler } from '../src/index.js';
import type { OfrepHandlerOptions } from '../src/index.js';
import { evaluateBulk, evaluateFlag, handlerFor, ORIGIN, post, readyClient } from './support.js';

const body = { context: { targetingKey: 'user-1' } };

describe('authorize', () => {
  it('is required', () => {
    const options = { client: () => readyClient() } as unknown as OfrepHandlerOptions;

    expect(() => createOfrepHandler(options)).toThrow(TypeError);
  });

  it('answers 401 when it returns false, before reading the body', async () => {
    const client = await readyClient();
    const evaluate = vi.spyOn(client, 'evaluate');
    const handler = handlerFor(client, { authorize: () => false });

    const single = await evaluateFlag(handler, 'theme', '{');
    const bulk = await evaluateBulk(handler, body);

    expect([single.status, bulk.status]).toEqual([401, 401]);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('answers 403 when it says so', async () => {
    const handler = handlerFor(await readyClient(), { authorize: () => ({ status: 403 }) });

    expect((await evaluateFlag(handler, 'theme', body)).status).toBe(403);
  });

  it('sends retry-after as seconds on a 429', async () => {
    const handler = handlerFor(await readyClient(), {
      authorize: () => Promise.resolve({ status: 429, retryAfter: 2.5 }),
    });

    const response = await evaluateBulk(handler, body);

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('3');
  });

  it('sends retry-after as an HTTP-date when given a Date', async () => {
    const until = new Date('2026-02-07T12:00:00Z');
    const handler = handlerFor(await readyClient(), {
      authorize: () => ({ status: 429, retryAfter: until }),
    });

    const response = await evaluateFlag(handler, 'theme', body);

    expect(response.headers.get('retry-after')).toBe('Sat, 07 Feb 2026 12:00:00 GMT');
  });

  it('sends a bare 429 without a retryAfter', async () => {
    const handler = handlerFor(await readyClient(), { authorize: () => ({ status: 429 }) });

    const response = await evaluateFlag(handler, 'theme', body);

    expect(response.status).toBe(429);
    expect(response.headers.has('retry-after')).toBe(false);
  });

  it('receives the request', async () => {
    const authorize = vi.fn(() => true);
    const handler = handlerFor(await readyClient(), { authorize });

    await evaluateFlag(handler, 'theme', body, { headers: { authorization: 'Bearer t' } });

    expect(authorize.mock.calls[0]).toEqual([expect.any(Request)]);
  });
});

describe('failures', () => {
  it('answers 500 and reports the error when the client cannot be obtained', async () => {
    const onError = vi.fn();
    const handler = createOfrepHandler({
      client: () => Promise.reject(new Error('KV is down')),
      authorize: () => true,
      onError,
    });

    const response = await evaluateBulk(handler, body);

    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain('KV is down');
    expect(onError).toHaveBeenCalledWith(new Error('KV is down'));
  });

  it('answers 500 when authorize throws a non-error', async () => {
    const onError = vi.fn();
    const handler = handlerFor(await readyClient(), {
      authorize: () => {
        // oxlint-disable-next-line no-throw-literal, typescript/only-throw-error
        throw 'nope';
      },
      onError,
    });

    expect((await evaluateFlag(handler, 'theme', body)).status).toBe(500);
    expect(onError).toHaveBeenCalledWith(new Error('nope'));
  });
});

// Routing outcomes sit outside the OFREP contract: no OFREP route was addressed.
describe('routing', () => {
  it.each(['/', '/ofrep/v1/evaluate', '/ofrep/v1/evaluate/flags/', '/ofrep/v1/evaluate/flagsx'])(
    'answers 404 with no body for %s',
    async (path) => {
      const response = await handlerFor(await readyClient())(post(path, body));

      expect(response.status).toBe(404);
      expect(await response.text()).toBe('');
    },
  );

  it('answers 405 to a method other than POST, without asking authorize', async () => {
    const authorize = vi.fn(() => true);
    const handler = handlerFor(await readyClient(), { authorize });

    const response = await handler(new Request(`${ORIGIN}/ofrep/v1/evaluate/flags`));

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
    expect(authorize).not.toHaveBeenCalled();
  });

  it.each(['/flags', '/flags/'])('serves both routes below basePath %s', async (basePath) => {
    const handler = handlerFor(await readyClient(), { basePath });

    const single = await evaluateFlag(handler, 'theme', body, {
      path: '/flags/ofrep/v1/evaluate/flags/theme',
    });
    const bulk = await evaluateBulk(handler, body, { path: '/flags/ofrep/v1/evaluate/flags' });
    const unprefixed = await handler(post('/ofrep/v1/evaluate/flags', body));

    expect([single.status, bulk.status, unprefixed.status]).toEqual([200, 200, 404]);
  });
});
