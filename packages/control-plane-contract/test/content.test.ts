import { describe, expect, it } from 'vitest';
import * as z from 'zod/mini';

import {
  flagSchema,
  segmentSchema,
  updateSegmentMembersRequestSchema,
  writeFlagRequestSchema,
  writeSegmentRequestSchema,
} from '../src/index.js';
import { ACTOR, AT, FLAG_DEFINITION, SEGMENT_DEFINITION } from './fixtures.js';

function keys(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `u${index}`);
}

describe('flag writes', () => {
  it('accepts a definition and keeps the fields the envelope does not name', () => {
    const result = z.safeParse(writeFlagRequestSchema, { definition: FLAG_DEFINITION });
    expect(result.success).toBe(true);
    expect(result.data?.definition).toEqual(FLAG_DEFINITION);
  });

  it('refuses a version in the definition, because the service assigns it', () => {
    const definition = { ...FLAG_DEFINITION, version: 7 };
    expect(z.safeParse(writeFlagRequestSchema, { definition }).success).toBe(false);
  });

  it.each([
    ['a missing offVariant', { ...FLAG_DEFINITION, offVariant: undefined }],
    ['a key with a slash', { ...FLAG_DEFINITION, key: 'a/b' }],
    ['a key over 128 characters', { ...FLAG_DEFINITION, key: 'k'.repeat(129) }],
    ['a non-boolean enabled', { ...FLAG_DEFINITION, enabled: 'yes' }],
  ])('rejects %s', (_name, definition) => {
    expect(z.safeParse(writeFlagRequestSchema, { definition }).success).toBe(false);
  });

  it('rejects a body field it does not know, so a typo is not silently ignored', () => {
    const body = { definition: FLAG_DEFINITION, expectedVersion: 3 };
    expect(z.safeParse(writeFlagRequestSchema, body).success).toBe(false);
  });
});

describe('flag responses', () => {
  const flag = {
    key: 'new-checkout',
    version: 4,
    definition: FLAG_DEFINITION,
    updatedAt: AT,
    updatedBy: ACTOR,
  };

  it('accepts a flag and keeps fields a newer server adds', () => {
    const result = z.safeParse(flagSchema, { ...flag, lifecycle: { owner: 'team' } });
    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty('lifecycle');
  });

  it('starts versions at 1 and keeps them integral', () => {
    expect(z.safeParse(flagSchema, { ...flag, version: 0 }).success).toBe(false);
    expect(z.safeParse(flagSchema, { ...flag, version: 1.5 }).success).toBe(false);
  });

  it('rejects an actor of an unknown type', () => {
    const updatedBy = { type: 'robot', id: 'x' };
    expect(z.safeParse(flagSchema, { ...flag, updatedBy }).success).toBe(false);
  });

  it('rejects a timestamp without a zone', () => {
    expect(z.safeParse(flagSchema, { ...flag, updatedAt: '2026-11-03T09:00:00' }).success).toBe(
      false,
    );
  });
});

describe('segments', () => {
  it('accepts a definition', () => {
    expect(z.safeParse(writeSegmentRequestSchema, { definition: SEGMENT_DEFINITION }).success).toBe(
      true,
    );
  });

  it('rejects included keys that are not strings', () => {
    const definition = { ...SEGMENT_DEFINITION, included: [1, 2] };
    expect(z.safeParse(writeSegmentRequestSchema, { definition }).success).toBe(false);
  });

  it('accepts a segment resource', () => {
    const segment = { key: 'beta-testers', version: 1, definition: SEGMENT_DEFINITION };
    const full = { ...segment, updatedAt: AT, updatedBy: ACTOR };
    expect(z.safeParse(segmentSchema, full).success).toBe(true);
  });
});

describe('segment member edits', () => {
  it('accepts additions and removals on one list', () => {
    const body = { list: 'included', add: ['user-3'], remove: ['user-1'] };
    expect(z.safeParse(updateSegmentMembersRequestSchema, body).success).toBe(true);
  });

  it('rejects an unknown list and an empty key', () => {
    expect(
      z.safeParse(updateSegmentMembersRequestSchema, { list: 'rules', add: ['x'] }).success,
    ).toBe(false);
    expect(
      z.safeParse(updateSegmentMembersRequestSchema, { list: 'excluded', add: [''] }).success,
    ).toBe(false);
  });

  it('caps one edit at 10 000 keys', () => {
    expect(
      z.safeParse(updateSegmentMembersRequestSchema, { list: 'included', add: keys(10_000) })
        .success,
    ).toBe(true);
    expect(
      z.safeParse(updateSegmentMembersRequestSchema, { list: 'included', add: keys(10_001) })
        .success,
    ).toBe(false);
  });
});
