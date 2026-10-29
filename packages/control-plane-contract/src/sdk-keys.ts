/**
 * SDK keys: credentials for the OFREP server, scoped to one environment. The
 * secret is returned once, at creation; the service keeps only its SHA-256 and
 * publishes the set of live hashes next to the ruleset, so the OFREP server
 * checks a key without calling the control plane.
 */

import { defineApiContract, noBodyResponse } from '@toad-contracts/core';
import * as z from 'zod/mini';

import {
  AUTH_ERRORS,
  actorSchema,
  authHeadersSchema,
  errorSchema,
  idSchema,
  timestampSchema,
} from './common.js';
import { environmentPath, environmentPathParamsSchema, sdkKeyPathParamsSchema } from './paths.js';
import type { EnvironmentPathParams } from './paths.js';

/**
 * `server` keys see every flag. `client` keys ship inside browser and mobile
 * apps, so they are public in practice and the OFREP server applies its
 * `bulkFilter` to them.
 */
export const SDK_KEY_KINDS = ['server', 'client'] as const;

export type SdkKeyKind = (typeof SDK_KEY_KINDS)[number];

export const sdkKeySchema = z.looseObject({
  id: idSchema,
  name: z.string(),
  kind: z.enum(SDK_KEY_KINDS),
  /** The first characters of the secret, enough to recognise it in a config file. */
  prefix: z.string(),
  createdAt: timestampSchema,
  createdBy: actorSchema,
});

export type SdkKey = z.infer<typeof sdkKeySchema>;

export const createSdkKeyRequestSchema = z.strictObject({
  name: z.string().check(z.minLength(1), z.maxLength(100)),
  kind: z.enum(SDK_KEY_KINDS),
});

/** The secret, `kw_<kind>_` followed by random characters, appears in this response only. */
export const createdSdkKeySchema = z.looseObject({
  key: sdkKeySchema,
  secret: z.string().check(z.regex(/^kw_(?:server|client)_[A-Za-z0-9]{32,}$/u)),
});

function sdkKeysPath(params: EnvironmentPathParams): string {
  return `${environmentPath(params)}/sdk-keys`;
}

export const listSdkKeysContract = defineApiContract({
  method: 'get',
  summary: 'List the live SDK keys of an environment',
  tags: ['SDK keys'],
  requestPathParamsSchema: environmentPathParamsSchema,
  pathResolver: (params) => sdkKeysPath(params),
  requestHeaderSchema: authHeadersSchema,
  responsesByStatusCode: {
    200: z.looseObject({ sdkKeys: z.array(sdkKeySchema) }),
    ...AUTH_ERRORS,
    404: errorSchema,
  },
});

export const createSdkKeyContract = defineApiContract({
  method: 'post',
  summary: 'Create an SDK key',
  description: 'Organisation admins only. Publishes the key set.',
  tags: ['SDK keys'],
  requestPathParamsSchema: environmentPathParamsSchema,
  pathResolver: (params) => sdkKeysPath(params),
  requestHeaderSchema: authHeadersSchema,
  requestBodySchema: createSdkKeyRequestSchema,
  responsesByStatusCode: {
    201: createdSdkKeySchema,
    400: errorSchema,
    ...AUTH_ERRORS,
    404: errorSchema,
  },
});

export const revokeSdkKeyContract = defineApiContract({
  method: 'delete',
  summary: 'Revoke an SDK key',
  description: 'Organisation admins only. Takes effect when the OFREP server next refreshes.',
  tags: ['SDK keys'],
  requestPathParamsSchema: sdkKeyPathParamsSchema,
  pathResolver: (params) => `${sdkKeysPath(params)}/${params.sdkKey}`,
  requestHeaderSchema: authHeadersSchema,
  responsesByStatusCode: {
    204: noBodyResponse({ description: 'Revoked and the key set published.' }),
    ...AUTH_ERRORS,
    404: errorSchema,
  },
});
