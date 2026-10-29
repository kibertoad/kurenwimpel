/**
 * Building blocks shared by every route of the control plane API.
 *
 * Request bodies are `strictObject`s: this is a first-party API, and a
 * misspelt field such as `requiredAprovals` should be a 400, not a silently
 * ignored setting. Response bodies are `looseObject`s, so a client built
 * against this version keeps working when the server adds a field.
 */

import * as z from 'zod/mini';

/** Path prefix every control plane route lives under. */
export const CONTROL_PLANE_BASE_PATH = '/api/v1';

/** Organisation, project and environment identifiers: lowercase URL slugs. */
export const slugSchema = z.string().check(z.regex(/^[a-z0-9][a-z0-9-]{0,62}$/u));

/**
 * Flag and segment keys. Narrower than what the engine accepts, so a key is
 * always safe to place in a path segment without encoding.
 */
export const resourceKeySchema = z
  .string()
  .check(z.maxLength(128), z.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u));

/** Opaque server-assigned identifier (change requests, schedules, SDK keys, audit events). */
export const idSchema = z.string().check(z.minLength(1));

export const timestampSchema = z.iso.datetime({ offset: true });

/**
 * A resource version for optimistic concurrency. Starts at 1 and grows by one
 * on every change; it never goes back, a rollback included.
 */
export const versionSchema = z.int().check(z.minimum(1));

/** `0` in a change request operation means "the resource must not exist yet". */
export const expectedVersionSchema = z.int().check(z.minimum(0));

export const ROLES = ['viewer', 'editor', 'approver'] as const;

export type Role = (typeof ROLES)[number];

export const roleSchema = z.enum(ROLES);

export const ACTOR_TYPES = ['user', 'service', 'scheduler'] as const;

/** Who made a change: a person, a machine identity from OIDC, or the scheduler itself. */
export const actorSchema = z.looseObject({
  type: z.enum(ACTOR_TYPES),
  /** The OIDC `sub`, or the schedule id for the scheduler. */
  id: z.string(),
  displayName: z.optional(z.string()),
});

export type Actor = z.infer<typeof actorSchema>;

/** Any JSON object. Arrays and null are not objects here. */
export const jsonObjectSchema = z.record(z.string(), z.unknown());

export const ERROR_CODES = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION_FAILED',
  'ALREADY_EXISTS',
  'VERSION_CONFLICT',
  'CHANGE_REQUEST_REQUIRED',
  'MANAGED_BY_GIT',
  'RULESET_ISSUES',
  'PAYLOAD_TOO_LARGE',
  'NOT_APPROVED',
  'SELF_APPROVAL',
  'PUBLISH_FAILED',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const errorSchema = z.looseObject({
  code: z.enum(ERROR_CODES),
  message: z.string(),
  /** Parse issues for `RULESET_ISSUES`, field errors for `VALIDATION_FAILED`. */
  issues: z.optional(z.array(z.looseObject({ at: z.string(), message: z.string() }))),
  /** The version the server holds, on `VERSION_CONFLICT`. */
  currentVersion: z.optional(z.int()),
});

export type ControlPlaneError = z.infer<typeof errorSchema>;

/**
 * Every route requires a bearer token: an OIDC access token for people, or one
 * from a client-credentials or workload identity grant for automation.
 */
export const authHeadersSchema = z.looseObject({
  authorization: z.string().check(z.regex(/^Bearer \S+$/u)),
});

/** The resource version as a strong ETag, `"3"`, which `if-match` echoes back. */
export const ifMatchHeadersSchema = z.looseObject({
  authorization: z.string().check(z.regex(/^Bearer \S+$/u)),
  'if-match': z.string().check(z.regex(/^"[1-9]\d*"$/u)),
});

export const etagHeadersSchema = z.looseObject({
  etag: z.optional(z.string()),
});

/** Statuses every authenticated route can answer with, all carrying an error body. */
export const AUTH_ERRORS = { 401: errorSchema, 403: errorSchema } as const;
