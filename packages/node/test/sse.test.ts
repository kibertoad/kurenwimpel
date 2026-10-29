import { afterEach, describe, expect, it, vi } from 'vitest';

import { reconnectDelay } from '../src/change-stream.js';
import { isRefetchEvent, SseDataReader } from '../src/sse.js';

describe('SseDataReader', () => {
  it('joins events split across chunks and drops comments and other fields', () => {
    const reader = new SseDataReader();

    expect(reader.push(': connected\n\nevent: x\nid: 1\nda')).toEqual([]);
    expect(reader.push('ta: {"a":1}\n')).toEqual([]);
    expect(reader.push('\ndata:b\r\n\r\n')).toEqual(['{"a":1}', 'b']);
  });

  it('joins multi-line data with newlines and skips events without data', () => {
    const reader = new SseDataReader();

    expect(reader.push('data: one\ndata: two\n\nretry: 5\n\n')).toEqual(['one\ntwo']);
  });
});

describe('isRefetchEvent', () => {
  it('accepts refetchEvaluation and ignores everything else', () => {
    expect(isRefetchEvent('{"type":"refetchEvaluation","lastModified":1}')).toBe(true);
    expect(isRefetchEvent('{"type":"somethingNew"}')).toBe(false);
    expect(isRefetchEvent('null')).toBe(false);
    expect(isRefetchEvent('"refetchEvaluation"')).toBe(false);
    expect(isRefetchEvent('{not json')).toBe(false);
  });
});

describe('reconnectDelay', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('doubles per failure between half and all of the step', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect([0, 1, 2, 3].map((failures) => reconnectDelay(failures, 30_000))).toEqual([
      250, 500, 1000, 2000,
    ]);

    vi.spyOn(Math, 'random').mockReturnValue(1);
    expect(reconnectDelay(2, 30_000)).toBe(2000);
  });

  it('stops growing at the ceiling', () => {
    vi.spyOn(Math, 'random').mockReturnValue(1);

    expect(reconnectDelay(20, 30_000)).toBe(30_000);
  });
});
