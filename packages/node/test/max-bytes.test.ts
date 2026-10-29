import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_HTTP_MAX_BYTES, HttpFlagProvider } from '../src/index.js';
import type { FlagDefinition } from '../src/index.js';

const ruleset: FlagDefinition[] = [
  {
    key: 'new-checkout',
    enabled: true,
    variants: { on: true, off: false },
    defaultVariant: 'on',
    offVariant: 'off',
  },
];

const body = JSON.stringify(ruleset);
const bodyBytes = new TextEncoder().encode(body).byteLength;

/** A body with no Content-Length, delivered in chunks, that records whether it was cancelled. */
function chunkedBody(text: string, chunkSize: number) {
  const bytes = new TextEncoder().encode(text);
  const state = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulled >= bytes.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(state.pulled, state.pulled + chunkSize));
      state.pulled += chunkSize;
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

function provider(response: Response, maxBytes?: number): HttpFlagProvider {
  return new HttpFlagProvider({
    url: 'https://flags.test/current',
    fetch: () => Promise.resolve(response),
    ...(maxBytes === undefined ? {} : { maxBytes }),
  });
}

describe('HttpFlagProvider maxBytes', () => {
  it('defaults to 10 MiB', () => {
    expect(DEFAULT_HTTP_MAX_BYTES).toBe(10 * 1024 * 1024);
  });

  it('accepts a body of exactly maxBytes', async () => {
    const snapshot = await provider(new Response(body), bodyBytes).load();

    expect(snapshot?.flags.size).toBe(1);
  });

  it('rejects on Content-Length alone, without reading the body', async () => {
    const { stream, state } = chunkedBody(body, 16);
    const response = new Response(stream, { headers: { 'content-length': String(bodyBytes) } });

    await expect(provider(response, bodyBytes - 1).load()).rejects.toThrow(/maxBytes/u);
    expect(state.pulled).toBeLessThanOrEqual(16);
    expect(state.cancelled).toBe(true);
  });

  it('stops reading a body without Content-Length once it passes the limit', async () => {
    const { stream, state } = chunkedBody(body.repeat(1000), 16);

    await expect(provider(new Response(stream), 64).load()).rejects.toThrow(/maxBytes/u);
    expect(state.pulled).toBeLessThan(1024);
    expect(state.cancelled).toBe(true);
  });

  it('caps the body even when Content-Length understates it', async () => {
    const { stream } = chunkedBody(body, 16);
    const response = new Response(stream, { headers: { 'content-length': '10' } });

    await expect(provider(response, bodyBytes - 1).load()).rejects.toThrow(/maxBytes/u);
  });

  it('counts bytes rather than characters', async () => {
    const wide = JSON.stringify([{ ...ruleset[0], metadata: { owner: 'ü'.repeat(20) } }]);

    await expect(provider(new Response(wide), wide.length).load()).rejects.toThrow(/maxBytes/u);
  });

  it('never parses an oversized body', async () => {
    const parse = vi.spyOn(JSON, 'parse');

    await expect(provider(new Response(body), 8).load()).rejects.toThrow(/maxBytes/u);
    expect(parse).not.toHaveBeenCalled();
    parse.mockRestore();
  });

  it.each([0, -1, 1.5, Number.NaN])('refuses maxBytes of %s', (maxBytes) => {
    expect(() => provider(new Response(body), maxBytes)).toThrow(RangeError);
  });
});
