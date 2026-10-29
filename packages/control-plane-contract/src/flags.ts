/**
 * Flags of one environment. The server validates every definition with the
 * engine's `parseRuleset`; this contract only pins the envelope and the fields
 * the service itself relies on.
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
import { environmentPath, environmentPathParamsSchema, flagPathParamsSchema } from './paths.js';
import type { EnvironmentPathParams } from './paths.js';

/**
 * A flag definition as the ruleset document carries it, minus `version`. The
 * service owns the version and stamps it into the published document, where it
 * reaches impressions as `flagVersion`, so a client may not set it.
 */
export const flagDefinitionSchema = z.looseObject({
  key: resourceKeySchema,
  enabled: z.boolean(),
  variants: z.record(z.string(), z.unknown()),
  defaultVariant: z.string(),
  offVariant: z.string(),
  version: z.optional(z.never()),
});

export type FlagDefinitionInput = z.infer<typeof flagDefinitionSchema>;

export const flagSchema = z.looseObject({
  key: resourceKeySchema,
  version: versionSchema,
  definition: flagDefinitionSchema,
  updatedAt: timestampSchema,
  updatedBy: actorSchema,
});

export type Flag = z.infer<typeof flagSchema>;

/** One entry of a flag's history, read from the audit log. */
export const flagVersionSchema = z.looseObject({
  version: versionSchema,
  /** `null` for the version that deleted the flag. */
  definition: z.nullable(flagDefinitionSchema),
  at: timestampSchema,
  actor: actorSchema,
  changeRequestId: z.optional(z.string()),
});

export const writeFlagRequestSchema = z.strictObject({ definition: flagDefinitionSchema });

/** Errors every write to an environment's content can answer with. */
export const CONTENT_WRITE_ERRORS = {
  400: errorSchema,
  ...AUTH_ERRORS,
  404: errorSchema,
  /** `MANAGED_BY_GIT` or `CHANGE_REQUEST_REQUIRED`. */
  409: errorSchema,
  412: errorSchema,
  422: errorSchema,
} as const;

function flagsPath(params: EnvironmentPathParams): string {
  return `${environmentPath(params)}/flags`;
}

export const listFlagsContract = defineApiContract({
  method: 'get',
  summary: 'List the flags of an environment',
  tags: ['Flags'],
  requestPathParamsSchema: environmentPathParamsSchema,
  pathResolver: (params) => flagsPath(params),
  requestHeaderSchema: authHeadersSchema,
  responsesByStatusCode: {
    200: z.looseObject({ flags: z.array(flagSchema) }),
    ...AUTH_ERRORS,
    404: errorSchema,
  },
});

export const getFlagContract = defineApiContract({
  method: 'get',
  summary: 'Get a flag',
  tags: ['Flags'],
  requestPathParamsSchema: flagPathParamsSchema,
  pathResolver: (params) => `${flagsPath(params)}/${params.flag}`,
  requestHeaderSchema: authHeadersSchema,
  responseHeaderSchema: etagHeadersSchema,
  responsesByStatusCode: { 200: flagSchema, ...AUTH_ERRORS, 404: errorSchema },
});

export const createFlagContract = defineApiContract({
  method: 'post',
  summary: 'Create a flag',
  description:
    'Editors, in an unprotected environment owned by the service. Publishes the environment.',
  tags: ['Flags'],
  requestPathParamsSchema: environmentPathParamsSchema,
  pathResolver: (params) => flagsPath(params),
  requestHeaderSchema: authHeadersSchema,
  requestBodySchema: writeFlagRequestSchema,
  responseHeaderSchema: etagHeadersSchema,
  responsesByStatusCode: { 201: flagSchema, ...CONTENT_WRITE_ERRORS },
});

export const updateFlagContract = defineApiContract({
  method: 'put',
  summary: 'Replace a flag definition',
  description: '`if-match` carries the version the edit is based on. Publishes the environment.',
  tags: ['Flags'],
  requestPathParamsSchema: flagPathParamsSchema,
  pathResolver: (params) => `${flagsPath(params)}/${params.flag}`,
  requestHeaderSchema: ifMatchHeadersSchema,
  requestBodySchema: writeFlagRequestSchema,
  responseHeaderSchema: etagHeadersSchema,
  responsesByStatusCode: { 200: flagSchema, ...CONTENT_WRITE_ERRORS },
});

export const deleteFlagContract = defineApiContract({
  method: 'delete',
  summary: 'Delete a flag',
  description: '`if-match` carries the version being deleted. Publishes the environment.',
  tags: ['Flags'],
  requestPathParamsSchema: flagPathParamsSchema,
  pathResolver: (params) => `${flagsPath(params)}/${params.flag}`,
  requestHeaderSchema: ifMatchHeadersSchema,
  responsesByStatusCode: {
    204: noBodyResponse({ description: 'Deleted and published.' }),
    ...CONTENT_WRITE_ERRORS,
  },
});

export const listFlagVersionsContract = defineApiContract({
  method: 'get',
  summary: 'List the versions of a flag, newest first',
  tags: ['Flags'],
  requestPathParamsSchema: flagPathParamsSchema,
  pathResolver: (params) => `${flagsPath(params)}/${params.flag}/versions`,
  requestHeaderSchema: authHeadersSchema,
  responsesByStatusCode: {
    200: z.looseObject({ versions: z.array(flagVersionSchema) }),
    ...AUTH_ERRORS,
    404: errorSchema,
  },
});
