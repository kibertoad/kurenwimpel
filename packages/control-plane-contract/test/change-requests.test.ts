import { describe, expect, it } from 'vitest';
import * as z from 'zod/mini';

import {
  changeOperationSchema,
  changeRequestSchema,
  reviewRequestSchema,
  writeChangeRequestSchema,
} from '../src/index.js';
import { CHANGE_REQUEST, FLAG_DEFINITION, SCHEDULE_ENTRY, SEGMENT_DEFINITION } from './fixtures.js';

describe('change operations', () => {
  it.each([
    ['putFlag', { op: 'putFlag', definition: FLAG_DEFINITION, expectedVersion: 4 }],
    ['putFlag creating a flag', { op: 'putFlag', definition: FLAG_DEFINITION, expectedVersion: 0 }],
    ['deleteFlag', { op: 'deleteFlag', key: 'new-checkout', expectedVersion: 4 }],
    ['putSegment', { op: 'putSegment', definition: SEGMENT_DEFINITION, expectedVersion: 2 }],
    ['deleteSegment', { op: 'deleteSegment', key: 'beta-testers', expectedVersion: 2 }],
    ['schedule', { op: 'schedule', entry: SCHEDULE_ENTRY }],
    ['cancelSchedule', { op: 'cancelSchedule', id: 'checkout-ramp-50' }],
  ])('accepts %s', (_name, operation) => {
    expect(z.safeParse(changeOperationSchema, operation).success).toBe(true);
  });

  it.each([
    ['an unknown op', { op: 'renameFlag', key: 'a', expectedVersion: 1 }],
    ['a put without an expected version', { op: 'putFlag', definition: FLAG_DEFINITION }],
    ['a delete of a version that cannot exist', { op: 'deleteFlag', key: 'a', expectedVersion: 0 }],
    [
      'a negative expected version',
      { op: 'putSegment', definition: SEGMENT_DEFINITION, expectedVersion: -1 },
    ],
    ['a field from another op', { op: 'deleteFlag', key: 'a', expectedVersion: 1, definition: {} }],
    [
      'a schedule entry without a time',
      { op: 'schedule', entry: { ...SCHEDULE_ENTRY, at: undefined } },
    ],
  ])('rejects %s', (_name, operation) => {
    expect(z.safeParse(changeOperationSchema, operation).success).toBe(false);
  });
});

describe('opening a change request', () => {
  const body = { title: CHANGE_REQUEST.title, operations: CHANGE_REQUEST.operations };

  it('accepts a title and operations', () => {
    expect(z.safeParse(writeChangeRequestSchema, body).success).toBe(true);
  });

  it('rejects an empty title and an empty operation list', () => {
    expect(z.safeParse(writeChangeRequestSchema, { ...body, title: '' }).success).toBe(false);
    expect(z.safeParse(writeChangeRequestSchema, { ...body, operations: [] }).success).toBe(false);
  });

  it('rejects a status set by the client', () => {
    expect(z.safeParse(writeChangeRequestSchema, { ...body, status: 'approved' }).success).toBe(
      false,
    );
  });
});

describe('reviews', () => {
  it('accepts an approval with or without a comment', () => {
    expect(z.safeParse(reviewRequestSchema, { decision: 'approve' }).success).toBe(true);
    expect(z.safeParse(reviewRequestSchema, { decision: 'reject', comment: 'no' }).success).toBe(
      true,
    );
  });

  it('rejects any other decision', () => {
    expect(z.safeParse(reviewRequestSchema, { decision: 'abstain' }).success).toBe(false);
  });
});

describe('change request resource', () => {
  it('accepts an open request', () => {
    expect(z.safeParse(changeRequestSchema, CHANGE_REQUEST).success).toBe(true);
  });

  it('accepts an applied request with its revision and reviews', () => {
    const applied = {
      ...CHANGE_REQUEST,
      status: 'applied',
      appliedRevision: 'f'.repeat(64),
      reviews: [
        {
          reviewer: { type: 'user', id: 'oidc|7' },
          decision: 'approve',
          at: CHANGE_REQUEST.createdAt,
        },
      ],
    };
    expect(z.safeParse(changeRequestSchema, applied).success).toBe(true);
  });

  it('rejects a status outside the lifecycle', () => {
    expect(z.safeParse(changeRequestSchema, { ...CHANGE_REQUEST, status: 'merged' }).success).toBe(
      false,
    );
  });
});
