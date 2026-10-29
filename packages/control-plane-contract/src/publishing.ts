/**
 * Publishing an environment. The service builds the ruleset document from its
 * stored flags and segments and hands it to the same publisher the CLI uses
 * (`publishRuleset`, `rollbackRuleset` from `@kurenwimpel/cli`), so a revision
 * here is the SHA-256 of the document's canonical JSON, as it is in GitOps.
 */

import { ContractNoBody, defineApiContract } from '@toad-contracts/core';
import * as z from 'zod/mini';

import {
  AUTH_ERRORS,
  authHeadersSchema,
  errorSchema,
  jsonObjectSchema,
  timestampSchema,
} from './common.js';
import { environmentPath, environmentPathParamsSchema } from './paths.js';

/** A revision as `revisionOf` computes it: 64 lowercase hex characters. */
export const revisionSchema = z.string().check(z.regex(/^[0-9a-f]{64}$/u));

export const PUBLICATION_STATES = ['current', 'pending', 'failed'] as const;

/**
 * `desiredRevision` is what the stored content hashes to; `servedRevision` is
 * what the target serves. They differ while a publish is pending or after one
 * failed, and the next publish closes the gap.
 */
export const publicationSchema = z.looseObject({
  state: z.enum(PUBLICATION_STATES),
  desiredRevision: revisionSchema,
  servedRevision: z.optional(revisionSchema),
  publishedAt: z.optional(timestampSchema),
  lastError: z.optional(errorSchema),
});

export type Publication = z.infer<typeof publicationSchema>;

/** `PublishResult` from the publisher, minus what only a terminal needs. */
export const publishResultSchema = z.looseObject({
  status: z.enum(['published', 'unchanged']),
  revision: revisionSchema,
  previousRevision: z.optional(revisionSchema),
  bytes: z.int().check(z.minimum(0)),
});

export const revisionEntrySchema = z.looseObject({
  revision: revisionSchema,
  publishedAt: z.optional(timestampSchema),
  current: z.boolean(),
});

/** `to` is a revision or a unique prefix of one; absent means the one before the current. */
export const rollbackRequestSchema = z.strictObject({
  to: z.optional(z.string().check(z.regex(/^[0-9a-f]{4,64}$/u))),
});

export const rollbackResultSchema = z.looseObject({
  status: z.enum(['rolled-back', 'unchanged']),
  from: z.optional(revisionSchema),
  to: revisionSchema,
});

/** The `{ schemaVersion, flags, segments }` document form, flags and segments sorted by key. */
export const rulesetDocumentSchema = z.looseObject({
  schemaVersion: z.optional(z.int()),
  flags: z.array(jsonObjectSchema),
  segments: z.array(jsonObjectSchema),
});

export const importRequestSchema = z.strictObject({ document: rulesetDocumentSchema });

const ENV_ROUTE = {
  requestPathParamsSchema: environmentPathParamsSchema,
  requestHeaderSchema: authHeadersSchema,
} as const;

export const getPublicationContract = defineApiContract({
  method: 'get',
  summary: 'Get the publication state of an environment',
  tags: ['Publishing'],
  ...ENV_ROUTE,
  pathResolver: (params) => `${environmentPath(params)}/publication`,
  responsesByStatusCode: { 200: publicationSchema, ...AUTH_ERRORS, 404: errorSchema },
});

export const publishContract = defineApiContract({
  method: 'post',
  summary: 'Publish the stored content',
  description: 'Retries a pending or failed publish. Writes nothing when the target is current.',
  tags: ['Publishing'],
  ...ENV_ROUTE,
  pathResolver: (params) => `${environmentPath(params)}/publish`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: {
    200: publishResultSchema,
    ...AUTH_ERRORS,
    404: errorSchema,
    409: errorSchema,
    502: errorSchema,
  },
});

export const listRevisionsContract = defineApiContract({
  method: 'get',
  summary: 'List the revisions the target keeps, newest first',
  tags: ['Publishing'],
  ...ENV_ROUTE,
  pathResolver: (params) => `${environmentPath(params)}/revisions`,
  responsesByStatusCode: {
    200: z.looseObject({ revisions: z.array(revisionEntrySchema) }),
    ...AUTH_ERRORS,
    404: errorSchema,
    502: errorSchema,
  },
});

export const rollbackContract = defineApiContract({
  method: 'post',
  summary: 'Serve an earlier revision again',
  description:
    'Approvers only. Repoints the target and restores the stored content to that revision, as new versions of every flag and segment it changes.',
  tags: ['Publishing'],
  ...ENV_ROUTE,
  pathResolver: (params) => `${environmentPath(params)}/rollback`,
  requestBodySchema: rollbackRequestSchema,
  responsesByStatusCode: {
    200: rollbackResultSchema,
    400: errorSchema,
    ...AUTH_ERRORS,
    404: errorSchema,
    409: errorSchema,
    502: errorSchema,
  },
});

export const exportDocumentContract = defineApiContract({
  method: 'get',
  summary: 'Export the environment as a ruleset document',
  description: 'The exact document the service publishes, ready to commit for a handover to Git.',
  tags: ['Publishing'],
  ...ENV_ROUTE,
  pathResolver: (params) => `${environmentPath(params)}/document`,
  responsesByStatusCode: { 200: rulesetDocumentSchema, ...AUTH_ERRORS, 404: errorSchema },
});

export const importDocumentContract = defineApiContract({
  method: 'post',
  summary: 'Take an environment over from Git',
  description:
    'Organisation admins only, on an environment whose source is `git`. Replaces the stored content with the document, sets the source to `service` and publishes.',
  tags: ['Publishing'],
  ...ENV_ROUTE,
  pathResolver: (params) => `${environmentPath(params)}/import`,
  requestBodySchema: importRequestSchema,
  responsesByStatusCode: {
    200: publishResultSchema,
    400: errorSchema,
    ...AUTH_ERRORS,
    404: errorSchema,
    409: errorSchema,
    422: errorSchema,
    502: errorSchema,
  },
});
