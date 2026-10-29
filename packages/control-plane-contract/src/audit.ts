/**
 * The audit log: one append-only event per change, written in the same
 * transaction as the change itself. The API reads it and never edits it.
 */

import { defineApiContract } from '@toad-contracts/core';
import * as z from 'zod/mini';

import {
  AUTH_ERRORS,
  actorSchema,
  authHeadersSchema,
  errorSchema,
  idSchema,
  slugSchema,
  timestampSchema,
} from './common.js';
import { orgPath, orgPathParamsSchema } from './paths.js';

export const AUDIT_RESOURCE_TYPES = [
  'project',
  'environment',
  'flag',
  'segment',
  'changeRequest',
  'schedule',
  'sdkKey',
  'publication',
] as const;

export const AUDIT_ACTIONS = [
  'create',
  'update',
  'delete',
  'review',
  'apply',
  'close',
  'fire',
  'publish',
  'rollback',
  'import',
  'revoke',
] as const;

export const auditEventSchema = z.looseObject({
  id: idSchema,
  at: timestampSchema,
  actor: actorSchema,
  action: z.enum(AUDIT_ACTIONS),
  resource: z.looseObject({
    type: z.enum(AUDIT_RESOURCE_TYPES),
    /** A slug, a flag or segment key, or an id, depending on `type`. */
    key: z.string(),
  }),
  project: z.optional(slugSchema),
  environment: z.optional(slugSchema),
  /** The resource before and after; `null` on the side where it did not exist. Secrets are never recorded. */
  before: z.nullable(z.unknown()),
  after: z.nullable(z.unknown()),
  /** Set when the change came from applying a change request. */
  changeRequestId: z.optional(idSchema),
  /** The ruleset revision the change was published as, when it was. */
  revision: z.optional(z.string()),
});

export type AuditEvent = z.infer<typeof auditEventSchema>;

/** Filters combine with AND. `since` and `until` bound `at`, inclusive and exclusive. */
export const listAuditEventsQuerySchema = z.strictObject({
  project: z.optional(slugSchema),
  environment: z.optional(slugSchema),
  resourceType: z.optional(z.enum(AUDIT_RESOURCE_TYPES)),
  resourceKey: z.optional(z.string()),
  actor: z.optional(z.string()),
  since: z.optional(timestampSchema),
  until: z.optional(timestampSchema),
  cursor: z.optional(z.string()),
  limit: z.optional(z.string().check(z.regex(/^(?:[1-9]\d?|100)$/u))),
});

export const listAuditEventsContract = defineApiContract({
  method: 'get',
  summary: 'List audit events, newest first',
  description:
    'Viewers see the events of environments they can view; organisation admins see all of them.',
  tags: ['Audit'],
  requestPathParamsSchema: orgPathParamsSchema,
  pathResolver: (params) => `${orgPath(params)}/audit-events`,
  requestHeaderSchema: authHeadersSchema,
  requestQuerySchema: listAuditEventsQuerySchema,
  responsesByStatusCode: {
    200: z.looseObject({
      events: z.array(auditEventSchema),
      /** Absent on the last page. */
      nextCursor: z.optional(z.string()),
    }),
    400: errorSchema,
    ...AUTH_ERRORS,
    404: errorSchema,
  },
});
