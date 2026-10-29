/**
 * Change requests: how content changes reach a protected environment. A
 * request holds a list of operations, each pinned to the version it was
 * written against, and applies them atomically once enough approvers other
 * than the author have approved.
 */

import { ContractNoBody, defineApiContract } from '@toad-contracts/core';
import * as z from 'zod/mini';

import {
  AUTH_ERRORS,
  actorSchema,
  authHeadersSchema,
  errorSchema,
  etagHeadersSchema,
  expectedVersionSchema,
  idSchema,
  ifMatchHeadersSchema,
  resourceKeySchema,
  slugSchema,
  timestampSchema,
  versionSchema,
} from './common.js';
import { CONTENT_WRITE_ERRORS, flagDefinitionSchema } from './flags.js';
import {
  changeRequestPathParamsSchema,
  environmentPath,
  environmentPathParamsSchema,
} from './paths.js';
import type { EnvironmentPathParams } from './paths.js';
import { scheduleEntryInputSchema } from './schedules.js';
import { segmentDefinitionSchema } from './segments.js';

/** One change. `expectedVersion: 0` on a put means the resource must not exist yet. */
export const changeOperationSchema = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('putFlag'),
    definition: flagDefinitionSchema,
    expectedVersion: expectedVersionSchema,
  }),
  z.strictObject({
    op: z.literal('deleteFlag'),
    key: resourceKeySchema,
    expectedVersion: versionSchema,
  }),
  z.strictObject({
    op: z.literal('putSegment'),
    definition: segmentDefinitionSchema,
    expectedVersion: expectedVersionSchema,
  }),
  z.strictObject({
    op: z.literal('deleteSegment'),
    key: resourceKeySchema,
    expectedVersion: versionSchema,
  }),
  z.strictObject({ op: z.literal('schedule'), entry: scheduleEntryInputSchema }),
  z.strictObject({ op: z.literal('cancelSchedule'), id: slugSchema }),
]);

export type ChangeOperation = z.infer<typeof changeOperationSchema>;

export const CHANGE_REQUEST_STATUSES = [
  'open',
  'approved',
  'rejected',
  'applied',
  'closed',
] as const;

export type ChangeRequestStatus = (typeof CHANGE_REQUEST_STATUSES)[number];

export const reviewSchema = z.looseObject({
  reviewer: actorSchema,
  decision: z.enum(['approve', 'reject']),
  comment: z.optional(z.string()),
  at: timestampSchema,
});

export const changeRequestSchema = z.looseObject({
  id: idSchema,
  title: z.string(),
  description: z.optional(z.string()),
  status: z.enum(CHANGE_REQUEST_STATUSES),
  author: actorSchema,
  operations: z.array(changeOperationSchema),
  /** Reviews of the current revision of the request. Editing it clears them. */
  reviews: z.array(reviewSchema),
  version: versionSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  /** The ruleset revision the apply published. */
  appliedRevision: z.optional(z.string()),
});

export type ChangeRequest = z.infer<typeof changeRequestSchema>;

export const writeChangeRequestSchema = z.strictObject({
  title: z.string().check(z.minLength(1), z.maxLength(200)),
  description: z.optional(z.string()),
  operations: z.array(changeOperationSchema).check(z.minLength(1), z.maxLength(100)),
});

export const reviewRequestSchema = z.strictObject({
  decision: z.enum(['approve', 'reject']),
  comment: z.optional(z.string()),
});

export const listChangeRequestsQuerySchema = z.strictObject({
  status: z.optional(z.enum(CHANGE_REQUEST_STATUSES)),
});

function changeRequestsPath(params: EnvironmentPathParams): string {
  return `${environmentPath(params)}/change-requests`;
}

const ONE_REQUEST = { 200: changeRequestSchema, ...AUTH_ERRORS, 404: errorSchema } as const;

export const listChangeRequestsContract = defineApiContract({
  method: 'get',
  summary: 'List change requests, newest first',
  tags: ['Change requests'],
  requestPathParamsSchema: environmentPathParamsSchema,
  pathResolver: (params) => changeRequestsPath(params),
  requestHeaderSchema: authHeadersSchema,
  requestQuerySchema: listChangeRequestsQuerySchema,
  responsesByStatusCode: {
    200: z.looseObject({ changeRequests: z.array(changeRequestSchema) }),
    ...AUTH_ERRORS,
    404: errorSchema,
  },
});

export const createChangeRequestContract = defineApiContract({
  method: 'post',
  summary: 'Open a change request',
  tags: ['Change requests'],
  requestPathParamsSchema: environmentPathParamsSchema,
  pathResolver: (params) => changeRequestsPath(params),
  requestHeaderSchema: authHeadersSchema,
  requestBodySchema: writeChangeRequestSchema,
  responseHeaderSchema: etagHeadersSchema,
  responsesByStatusCode: { ...CONTENT_WRITE_ERRORS, 201: changeRequestSchema },
});

export const getChangeRequestContract = defineApiContract({
  method: 'get',
  summary: 'Get a change request',
  tags: ['Change requests'],
  requestPathParamsSchema: changeRequestPathParamsSchema,
  pathResolver: (params) => `${changeRequestsPath(params)}/${params.changeRequest}`,
  requestHeaderSchema: authHeadersSchema,
  responseHeaderSchema: etagHeadersSchema,
  responsesByStatusCode: ONE_REQUEST,
});

export const updateChangeRequestContract = defineApiContract({
  method: 'put',
  summary: 'Revise an open change request',
  description: 'Author only. Clears every review, so approvals always cover what gets applied.',
  tags: ['Change requests'],
  requestPathParamsSchema: changeRequestPathParamsSchema,
  pathResolver: (params) => `${changeRequestsPath(params)}/${params.changeRequest}`,
  requestHeaderSchema: ifMatchHeadersSchema,
  requestBodySchema: writeChangeRequestSchema,
  responseHeaderSchema: etagHeadersSchema,
  responsesByStatusCode: { ...CONTENT_WRITE_ERRORS, 200: changeRequestSchema },
});

export const reviewChangeRequestContract = defineApiContract({
  method: 'post',
  summary: 'Approve or reject a change request',
  description: 'Approvers other than the author. A self-review answers 403 `SELF_APPROVAL`.',
  tags: ['Change requests'],
  requestPathParamsSchema: changeRequestPathParamsSchema,
  pathResolver: (params) => `${changeRequestsPath(params)}/${params.changeRequest}/reviews`,
  requestHeaderSchema: ifMatchHeadersSchema,
  requestBodySchema: reviewRequestSchema,
  responsesByStatusCode: { ...ONE_REQUEST, 400: errorSchema, 409: errorSchema, 412: errorSchema },
});

export const applyChangeRequestContract = defineApiContract({
  method: 'post',
  summary: 'Apply an approved change request and publish',
  description:
    'Author or an approver. Applies every operation in one transaction, or none when any expected version is stale.',
  tags: ['Change requests'],
  requestPathParamsSchema: changeRequestPathParamsSchema,
  pathResolver: (params) => `${changeRequestsPath(params)}/${params.changeRequest}/apply`,
  requestHeaderSchema: ifMatchHeadersSchema,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { ...CONTENT_WRITE_ERRORS, 200: changeRequestSchema },
});

export const closeChangeRequestContract = defineApiContract({
  method: 'post',
  summary: 'Withdraw a change request without applying it',
  tags: ['Change requests'],
  requestPathParamsSchema: changeRequestPathParamsSchema,
  pathResolver: (params) => `${changeRequestsPath(params)}/${params.changeRequest}/close`,
  requestHeaderSchema: authHeadersSchema,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { ...ONE_REQUEST, 409: errorSchema },
});
