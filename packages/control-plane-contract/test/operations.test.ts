import { describe, expect, it } from 'vitest';
import * as z from 'zod/mini';

import {
  auditEventSchema,
  createdSdkKeySchema,
  createSdkKeyRequestSchema,
  errorSchema,
  importRequestSchema,
  listAuditEventsQuerySchema,
  publicationSchema,
  rollbackRequestSchema,
  scheduleEntryInputSchema,
  scheduleEntrySchema,
} from '../src/index.js';
import { ACTOR, AT, FLAG_DEFINITION, REVISION, SCHEDULE_ENTRY } from './fixtures.js';

describe('publishing', () => {
  it('accepts a publication that is behind its content', () => {
    const publication = {
      state: 'failed',
      desiredRevision: REVISION,
      servedRevision: 'b'.repeat(64),
      lastError: { code: 'PUBLISH_FAILED', message: 'kv answered 500' },
    };
    expect(z.safeParse(publicationSchema, publication).success).toBe(true);
  });

  it('rejects a revision that is not a SHA-256 in lowercase hex', () => {
    const publication = { state: 'current', desiredRevision: REVISION.toUpperCase() };
    expect(z.safeParse(publicationSchema, publication).success).toBe(false);
  });

  it('rolls back to the previous revision, a full one or a prefix of at least 4', () => {
    expect(z.safeParse(rollbackRequestSchema, {}).success).toBe(true);
    expect(z.safeParse(rollbackRequestSchema, { to: REVISION }).success).toBe(true);
    expect(z.safeParse(rollbackRequestSchema, { to: 'aaaa' }).success).toBe(true);
    expect(z.safeParse(rollbackRequestSchema, { to: 'aaa' }).success).toBe(false);
  });

  it('imports the document form only', () => {
    const document = { schemaVersion: 1, flags: [FLAG_DEFINITION], segments: [] };
    expect(z.safeParse(importRequestSchema, { document }).success).toBe(true);
    expect(z.safeParse(importRequestSchema, { document: [FLAG_DEFINITION] }).success).toBe(false);
  });
});

describe('schedules', () => {
  it('accepts the GitOps entry shape', () => {
    expect(z.safeParse(scheduleEntryInputSchema, SCHEDULE_ENTRY).success).toBe(true);
  });

  it.each([
    ['a time without a zone', { ...SCHEDULE_ENTRY, at: '2026-11-03 09:00' }],
    ['a patch that is not an object', { ...SCHEDULE_ENTRY, set: [1] }],
    ['an id that is not a slug', { ...SCHEDULE_ENTRY, id: 'Ramp 50' }],
  ])('rejects %s', (_name, entry) => {
    expect(z.safeParse(scheduleEntryInputSchema, entry).success).toBe(false);
  });

  it('reports why an entry failed when it fired', () => {
    const failure = { code: 'RULESET_ISSUES', message: 'unknown variant', issues: [] };
    const entry = { ...SCHEDULE_ENTRY, status: 'failed', createdBy: ACTOR, firedAt: AT, failure };
    expect(z.safeParse(scheduleEntrySchema, entry).success).toBe(true);
  });
});

describe('SDK keys', () => {
  it('creates server and client keys only', () => {
    expect(z.safeParse(createSdkKeyRequestSchema, { name: 'web', kind: 'client' }).success).toBe(
      true,
    );
    expect(z.safeParse(createSdkKeyRequestSchema, { name: 'web', kind: 'admin' }).success).toBe(
      false,
    );
  });

  it('returns a secret whose prefix names its kind', () => {
    const key = { id: 'k1', name: 'api', kind: 'server', prefix: 'kw_server_ab', createdAt: AT };
    const created = { key: { ...key, createdBy: ACTOR }, secret: `kw_server_${'a'.repeat(32)}` };
    expect(z.safeParse(createdSdkKeySchema, created).success).toBe(true);
    expect(z.safeParse(createdSdkKeySchema, { ...created, secret: 'short' }).success).toBe(false);
  });
});

describe('audit', () => {
  const event = {
    id: 'ev1',
    at: AT,
    actor: ACTOR,
    action: 'update',
    resource: { type: 'flag', key: 'new-checkout' },
    project: 'shop',
    environment: 'production',
    before: { ...FLAG_DEFINITION, enabled: false },
    after: FLAG_DEFINITION,
    revision: REVISION,
  };

  it('accepts an event with before and after', () => {
    expect(z.safeParse(auditEventSchema, event).success).toBe(true);
  });

  it('requires both sides, null where the resource did not exist', () => {
    expect(z.safeParse(auditEventSchema, { ...event, before: null }).success).toBe(true);
    const { before: _before, ...withoutBefore } = event;
    expect(z.safeParse(auditEventSchema, withoutBefore).success).toBe(false);
  });

  it('takes the page size as a digit string from 1 to 100', () => {
    for (const limit of ['1', '50', '100']) {
      expect(z.safeParse(listAuditEventsQuerySchema, { limit }).success).toBe(true);
    }
    for (const limit of ['0', '101', '10.5', 'all']) {
      expect(z.safeParse(listAuditEventsQuerySchema, { limit }).success).toBe(false);
    }
  });
});

describe('errors', () => {
  it('carries the current version on a conflict', () => {
    const conflict = { code: 'VERSION_CONFLICT', message: 'stale', currentVersion: 5 };
    expect(z.safeParse(errorSchema, conflict).data).toEqual(conflict);
  });

  it('rejects an unknown code', () => {
    expect(z.safeParse(errorSchema, { code: 'TEAPOT', message: 'x' }).success).toBe(false);
  });
});
