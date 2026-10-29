/**
 * The tenancy tree: organisation, project, environment. Flags and segments
 * belong to one environment, and each environment publishes one complete
 * ruleset document to one target.
 */

import { defineApiContract } from '@toad-contracts/core';
import * as z from 'zod/mini';

import {
  AUTH_ERRORS,
  authHeadersSchema,
  errorSchema,
  etagHeadersSchema,
  ifMatchHeadersSchema,
  roleSchema,
  slugSchema,
  timestampSchema,
  versionSchema,
} from './common.js';
import {
  environmentPath,
  environmentPathParamsSchema,
  orgPath,
  orgPathParamsSchema,
  projectPath,
  projectPathParamsSchema,
} from './paths.js';

export const organisationSchema = z.looseObject({
  slug: slugSchema,
  name: z.string(),
  /** OIDC groups whose members administer the organisation. */
  adminGroups: z.array(z.string()),
});

export type Organisation = z.infer<typeof organisationSchema>;

export const projectSchema = z.looseObject({
  key: slugSchema,
  name: z.string(),
  createdAt: timestampSchema,
});

export type Project = z.infer<typeof projectSchema>;

export const createProjectRequestSchema = z.strictObject({
  key: slugSchema,
  name: z.string().check(z.minLength(1)),
});

export const ENVIRONMENT_SOURCES = ['service', 'git'] as const;

export type EnvironmentSource = (typeof ENVIRONMENT_SOURCES)[number];

/** Grants `role` in one environment to every member of an OIDC group. */
export const roleBindingSchema = z.strictObject({
  group: z.string().check(z.minLength(1)),
  role: roleSchema,
});

/**
 * Where the environment publishes, in the shape `kurenwimpel.config.json`
 * uses for the same environment. Credentials are never part of it.
 */
export const publishTargetSchema = z.looseObject({
  type: z.enum(['kv', 'file', 's3', 'r2']),
});

const environmentSettings = {
  name: z.string().check(z.minLength(1)),
  /** Writes to a protected environment go through change requests. */
  protected: z.boolean(),
  /** Approvals a change request needs, from approvers other than its author. */
  requiredApprovals: z.int().check(z.minimum(1), z.maximum(5)),
  target: publishTargetSchema,
  roleBindings: z.array(roleBindingSchema),
};

export const environmentSchema = z.looseObject({
  key: slugSchema,
  ...environmentSettings,
  /** `git`: the service serves this environment read-only and never publishes it. */
  source: z.enum(ENVIRONMENT_SOURCES),
  version: versionSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export type Environment = z.infer<typeof environmentSchema>;

export const createEnvironmentRequestSchema = z.strictObject({
  key: slugSchema,
  ...environmentSettings,
  requiredApprovals: z.optional(environmentSettings.requiredApprovals),
  roleBindings: z.optional(environmentSettings.roleBindings),
  source: z.optional(z.enum(ENVIRONMENT_SOURCES)),
});

/**
 * A partial update. `source` can only be handed to Git here; taking an
 * environment over from Git is an import, so the service starts from what Git
 * last published.
 */
export const updateEnvironmentRequestSchema = z.strictObject({
  name: z.optional(environmentSettings.name),
  protected: z.optional(environmentSettings.protected),
  requiredApprovals: z.optional(environmentSettings.requiredApprovals),
  target: z.optional(environmentSettings.target),
  roleBindings: z.optional(environmentSettings.roleBindings),
  source: z.optional(z.literal('git')),
});

export const getOrganisationContract = defineApiContract({
  method: 'get',
  summary: 'Get an organisation',
  tags: ['Organisations'],
  requestPathParamsSchema: orgPathParamsSchema,
  pathResolver: (params) => orgPath(params),
  requestHeaderSchema: authHeadersSchema,
  responsesByStatusCode: { 200: organisationSchema, ...AUTH_ERRORS, 404: errorSchema },
});

export const listProjectsContract = defineApiContract({
  method: 'get',
  summary: 'List the projects of an organisation',
  tags: ['Organisations'],
  requestPathParamsSchema: orgPathParamsSchema,
  pathResolver: (params) => `${orgPath(params)}/projects`,
  requestHeaderSchema: authHeadersSchema,
  responsesByStatusCode: {
    200: z.looseObject({ projects: z.array(projectSchema) }),
    ...AUTH_ERRORS,
    404: errorSchema,
  },
});

export const createProjectContract = defineApiContract({
  method: 'post',
  summary: 'Create a project',
  description: 'Organisation admins only.',
  tags: ['Organisations'],
  requestPathParamsSchema: orgPathParamsSchema,
  pathResolver: (params) => `${orgPath(params)}/projects`,
  requestHeaderSchema: authHeadersSchema,
  requestBodySchema: createProjectRequestSchema,
  responsesByStatusCode: {
    201: projectSchema,
    400: errorSchema,
    ...AUTH_ERRORS,
    404: errorSchema,
    409: errorSchema,
  },
});

export const listEnvironmentsContract = defineApiContract({
  method: 'get',
  summary: 'List the environments of a project',
  tags: ['Environments'],
  requestPathParamsSchema: projectPathParamsSchema,
  pathResolver: (params) => `${projectPath(params)}/environments`,
  requestHeaderSchema: authHeadersSchema,
  responsesByStatusCode: {
    200: z.looseObject({ environments: z.array(environmentSchema) }),
    ...AUTH_ERRORS,
    404: errorSchema,
  },
});

export const createEnvironmentContract = defineApiContract({
  method: 'post',
  summary: 'Create an environment',
  description: 'Organisation admins only. `source` defaults to `service`.',
  tags: ['Environments'],
  requestPathParamsSchema: projectPathParamsSchema,
  pathResolver: (params) => `${projectPath(params)}/environments`,
  requestHeaderSchema: authHeadersSchema,
  requestBodySchema: createEnvironmentRequestSchema,
  responseHeaderSchema: etagHeadersSchema,
  responsesByStatusCode: {
    201: environmentSchema,
    400: errorSchema,
    ...AUTH_ERRORS,
    404: errorSchema,
    409: errorSchema,
  },
});

export const getEnvironmentContract = defineApiContract({
  method: 'get',
  summary: 'Get an environment',
  tags: ['Environments'],
  requestPathParamsSchema: environmentPathParamsSchema,
  pathResolver: (params) => environmentPath(params),
  requestHeaderSchema: authHeadersSchema,
  responseHeaderSchema: etagHeadersSchema,
  responsesByStatusCode: { 200: environmentSchema, ...AUTH_ERRORS, 404: errorSchema },
});

export const updateEnvironmentContract = defineApiContract({
  method: 'patch',
  summary: 'Change environment settings',
  description: 'Organisation admins only. `if-match` carries the version the change is based on.',
  tags: ['Environments'],
  requestPathParamsSchema: environmentPathParamsSchema,
  pathResolver: (params) => environmentPath(params),
  requestHeaderSchema: ifMatchHeadersSchema,
  requestBodySchema: updateEnvironmentRequestSchema,
  responseHeaderSchema: etagHeadersSchema,
  responsesByStatusCode: {
    200: environmentSchema,
    400: errorSchema,
    ...AUTH_ERRORS,
    404: errorSchema,
    412: errorSchema,
  },
});
