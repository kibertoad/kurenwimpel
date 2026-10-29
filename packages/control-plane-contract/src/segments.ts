/**
 * Segments of one environment. Besides whole-definition writes, a segment's
 * key lists take incremental member edits, which need no `if-match`: adding
 * and removing keys commute, so two support agents editing the same list at
 * once do not conflict.
 */

import { defineApiContract, noBodyResponse } from '@toad-contracts/core';
import * as z from 'zod/mini';

import {
  AUTH_ERRORS,
  actorSchema,
  authHeadersSchema,
  errorSchema,
  etagHeadersSchema,
  ifMatchHeadersSchema,
  resourceKeySchema,
  timestampSchema,
  versionSchema,
} from './common.js';
import { CONTENT_WRITE_ERRORS } from './flags.js';
import { environmentPath, environmentPathParamsSchema, segmentPathParamsSchema } from './paths.js';
import type { EnvironmentPathParams } from './paths.js';

/** A segment definition as the ruleset document carries it. */
export const segmentDefinitionSchema = z.looseObject({
  key: resourceKeySchema,
  included: z.optional(z.array(z.string())),
  excluded: z.optional(z.array(z.string())),
  rules: z.optional(z.array(z.looseObject({ id: z.string() }))),
});

export const segmentSchema = z.looseObject({
  key: resourceKeySchema,
  /** For concurrency only: segments carry no version in the published document. */
  version: versionSchema,
  definition: segmentDefinitionSchema,
  updatedAt: timestampSchema,
  updatedBy: actorSchema,
});

export type Segment = z.infer<typeof segmentSchema>;

export const writeSegmentRequestSchema = z.strictObject({ definition: segmentDefinitionSchema });

const memberKeysSchema = z.array(z.string().check(z.minLength(1))).check(z.maxLength(10_000));

/** Keys to add to or remove from `included` and `excluded`. Removing an absent key is a no-op. */
export const updateSegmentMembersRequestSchema = z.strictObject({
  list: z.enum(['included', 'excluded']),
  add: z.optional(memberKeysSchema),
  remove: z.optional(memberKeysSchema),
});

function segmentsPath(params: EnvironmentPathParams): string {
  return `${environmentPath(params)}/segments`;
}

export const listSegmentsContract = defineApiContract({
  method: 'get',
  summary: 'List the segments of an environment',
  tags: ['Segments'],
  requestPathParamsSchema: environmentPathParamsSchema,
  pathResolver: (params) => segmentsPath(params),
  requestHeaderSchema: authHeadersSchema,
  responsesByStatusCode: {
    200: z.looseObject({ segments: z.array(segmentSchema) }),
    ...AUTH_ERRORS,
    404: errorSchema,
  },
});

export const getSegmentContract = defineApiContract({
  method: 'get',
  summary: 'Get a segment',
  tags: ['Segments'],
  requestPathParamsSchema: segmentPathParamsSchema,
  pathResolver: (params) => `${segmentsPath(params)}/${params.segment}`,
  requestHeaderSchema: authHeadersSchema,
  responseHeaderSchema: etagHeadersSchema,
  responsesByStatusCode: { 200: segmentSchema, ...AUTH_ERRORS, 404: errorSchema },
});

export const createSegmentContract = defineApiContract({
  method: 'post',
  summary: 'Create a segment',
  tags: ['Segments'],
  requestPathParamsSchema: environmentPathParamsSchema,
  pathResolver: (params) => segmentsPath(params),
  requestHeaderSchema: authHeadersSchema,
  requestBodySchema: writeSegmentRequestSchema,
  responseHeaderSchema: etagHeadersSchema,
  responsesByStatusCode: { 201: segmentSchema, ...CONTENT_WRITE_ERRORS },
});

export const updateSegmentContract = defineApiContract({
  method: 'put',
  summary: 'Replace a segment definition',
  tags: ['Segments'],
  requestPathParamsSchema: segmentPathParamsSchema,
  pathResolver: (params) => `${segmentsPath(params)}/${params.segment}`,
  requestHeaderSchema: ifMatchHeadersSchema,
  requestBodySchema: writeSegmentRequestSchema,
  responseHeaderSchema: etagHeadersSchema,
  responsesByStatusCode: { 200: segmentSchema, ...CONTENT_WRITE_ERRORS },
});

export const updateSegmentMembersContract = defineApiContract({
  method: 'post',
  summary: 'Add or remove targeting keys',
  description: 'No `if-match`: member edits commute. Publishes the environment.',
  tags: ['Segments'],
  requestPathParamsSchema: segmentPathParamsSchema,
  pathResolver: (params) => `${segmentsPath(params)}/${params.segment}/members`,
  requestHeaderSchema: authHeadersSchema,
  requestBodySchema: updateSegmentMembersRequestSchema,
  responseHeaderSchema: etagHeadersSchema,
  responsesByStatusCode: { 200: segmentSchema, ...CONTENT_WRITE_ERRORS },
});

export const deleteSegmentContract = defineApiContract({
  method: 'delete',
  summary: 'Delete a segment',
  description: 'Refused with `RULESET_ISSUES` while a flag still references the segment.',
  tags: ['Segments'],
  requestPathParamsSchema: segmentPathParamsSchema,
  pathResolver: (params) => `${segmentsPath(params)}/${params.segment}`,
  requestHeaderSchema: ifMatchHeadersSchema,
  responsesByStatusCode: {
    204: noBodyResponse({ description: 'Deleted and published.' }),
    ...CONTENT_WRITE_ERRORS,
  },
});
