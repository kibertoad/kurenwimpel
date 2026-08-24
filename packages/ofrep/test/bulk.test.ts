import { safeParse } from 'valibot';
import { describe, expect, it } from 'vitest';

import {
  bulkEvaluationEntrySchema,
  bulkEvaluationFailureSchema,
  bulkEvaluationRequestSchema,
  bulkEvaluationSuccessSchema,
  endpointEventStreamSchema,
  eventStreamSchema,
  sseEventDataSchema,
  sseEventSchema,
  urlEventStreamSchema,
} from '../src/index.js';
import {
  BULK_EVALUATION_FAILURE,
  BULK_EVALUATION_REQUEST,
  BULK_EVALUATION_SUCCESS,
  EVENT_STREAM_ENDPOINT,
} from './fixtures.js';

describe('bulk evaluation', () => {
  it('accepts the specification request example', () => {
    expect(safeParse(bulkEvaluationRequestSchema, BULK_EVALUATION_REQUEST).success).toBe(true);
  });

  it('accepts the specification response example, mixed successes and failures included', () => {
    const result = safeParse(bulkEvaluationSuccessSchema, BULK_EVALUATION_SUCCESS);
    expect(result.success).toBe(true);
    expect(result.output).toEqual(BULK_EVALUATION_SUCCESS);
  });

  it('accepts an empty flag set', () => {
    expect(safeParse(bulkEvaluationSuccessSchema, { flags: [] }).success).toBe(true);
  });

  it('requires the flags array', () => {
    expect(safeParse(bulkEvaluationSuccessSchema, { metadata: { version: 'v12' } }).success).toBe(
      false,
    );
  });

  it('accepts the specification failure example', () => {
    expect(safeParse(bulkEvaluationFailureSchema, BULK_EVALUATION_FAILURE).success).toBe(true);
  });

  it('leaves the bulk failure error code open, unlike the per-flag one', () => {
    expect(
      safeParse(bulkEvaluationFailureSchema, { errorCode: 'PROVIDER_NOT_READY' }).success,
    ).toBe(true);
  });

  it.each([
    ['a success', { key: 'k', value: true, reason: 'STATIC' }],
    ['a failure', { key: 'k', errorCode: 'GENERAL' }],
    ['an unknown key', { key: 'k', errorCode: 'FLAG_NOT_FOUND' }],
  ])('reads %s as a flag entry', (_name, entry) => {
    expect(safeParse(bulkEvaluationEntrySchema, entry).success).toBe(true);
  });

  it('rejects an entry that is neither', () => {
    expect(safeParse(bulkEvaluationEntrySchema, { key: 'k' }).success).toBe(false);
  });
});

describe('event streams', () => {
  it('accepts the url form', () => {
    const result = safeParse(urlEventStreamSchema, {
      type: 'sse',
      url: 'https://sse.example.com/event-stream?channels=env_abc123_v1',
    });
    expect(result.success).toBe(true);
  });

  it('accepts the endpoint form', () => {
    const result = safeParse(endpointEventStreamSchema, {
      type: 'sse',
      endpoint: EVENT_STREAM_ENDPOINT,
    });
    expect(result.success).toBe(true);
  });

  it('treats url and endpoint as mutually exclusive', () => {
    const both = {
      type: 'sse',
      url: 'https://sse.example.com/stream',
      endpoint: EVENT_STREAM_ENDPOINT,
    };
    expect(safeParse(eventStreamSchema, both).success).toBe(false);
  });

  it('requires one of them', () => {
    expect(safeParse(eventStreamSchema, { type: 'sse' }).success).toBe(false);
  });

  it('keeps stream types it does not know, so a provider can ignore them', () => {
    const result = safeParse(eventStreamSchema, {
      type: 'websocket',
      url: 'wss://sse.example.com/stream',
    });
    expect(result.success).toBe(true);
  });

  it('requires a rooted request URI on the endpoint form', () => {
    expect(
      safeParse(endpointEventStreamSchema, {
        type: 'sse',
        endpoint: { requestUri: 'event-stream' },
      }).success,
    ).toBe(false);
  });

  it('rejects an inactivity delay below one second', () => {
    expect(
      safeParse(urlEventStreamSchema, {
        type: 'sse',
        url: 'https://sse.example.com/stream',
        inactivityDelaySec: 0,
      }).success,
    ).toBe(false);
  });
});

describe('server-sent events', () => {
  it('carries its payload as an unparsed JSON string', () => {
    const result = safeParse(sseEventSchema, {
      event: 'message',
      id: 'evt-1234',
      data: JSON.stringify({ type: 'refetchEvaluation', etag: 'abc123' }),
    });
    expect(result.success).toBe(true);
  });

  it('rejects a payload sent as an object rather than a string', () => {
    expect(safeParse(sseEventSchema, { data: { type: 'refetchEvaluation' } }).success).toBe(false);
  });

  it.each([
    ['unix seconds', 1_771_622_898],
    ['an ISO 8601 timestamp', '2026-02-20T21:28:18Z'],
  ])('accepts a lastModified given as %s', (_name, lastModified) => {
    const result = safeParse(sseEventDataSchema, { type: 'refetchEvaluation', lastModified });
    expect(result.success).toBe(true);
  });

  it('rejects a lastModified that is neither', () => {
    expect(
      safeParse(sseEventDataSchema, { type: 'refetchEvaluation', lastModified: '20/02/2026' })
        .success,
    ).toBe(false);
  });
});
