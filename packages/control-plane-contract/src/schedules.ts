/**
 * Scheduled flag changes. An entry has the shape of a GitOps schedule entry
 * (`flags/<env>.schedule.json`): `set` is a shallow patch over the flag
 * definition, checked with `parseRuleset` when the entry is written and again
 * when it fires.
 */

import { defineApiContract, noBodyResponse } from '@toad-contracts/core';
import * as z from 'zod/mini';

import {
  AUTH_ERRORS,
  actorSchema,
  authHeadersSchema,
  errorSchema,
  jsonObjectSchema,
  resourceKeySchema,
  slugSchema,
  timestampSchema,
} from './common.js';
import { CONTENT_WRITE_ERRORS } from './flags.js';
import { environmentPath, environmentPathParamsSchema, schedulePathParamsSchema } from './paths.js';
import type { EnvironmentPathParams } from './paths.js';

export const scheduleEntryInputSchema = z.strictObject({
  /** Chosen by the author and unique in the environment, as in the schedule file. */
  id: slugSchema,
  at: timestampSchema,
  flag: resourceKeySchema,
  set: jsonObjectSchema,
});

export type ScheduleEntryInput = z.infer<typeof scheduleEntryInputSchema>;

export const SCHEDULE_STATUSES = ['pending', 'applied', 'failed', 'cancelled'] as const;

export const scheduleEntrySchema = z.looseObject({
  id: slugSchema,
  at: timestampSchema,
  flag: resourceKeySchema,
  set: jsonObjectSchema,
  status: z.enum(SCHEDULE_STATUSES),
  createdBy: actorSchema,
  /** When it fired, for `applied` and `failed`. */
  firedAt: z.optional(timestampSchema),
  /** The flag version it produced, for `applied`. */
  appliedVersion: z.optional(z.int()),
  /** Why it did not apply, for `failed`. */
  failure: z.optional(errorSchema),
});

export type ScheduleEntry = z.infer<typeof scheduleEntrySchema>;

export const listSchedulesQuerySchema = z.strictObject({
  status: z.optional(z.enum(SCHEDULE_STATUSES)),
});

function schedulesPath(params: EnvironmentPathParams): string {
  return `${environmentPath(params)}/schedules`;
}

export const listSchedulesContract = defineApiContract({
  method: 'get',
  summary: 'List schedule entries, soonest first',
  tags: ['Schedules'],
  requestPathParamsSchema: environmentPathParamsSchema,
  pathResolver: (params) => schedulesPath(params),
  requestHeaderSchema: authHeadersSchema,
  requestQuerySchema: listSchedulesQuerySchema,
  responsesByStatusCode: {
    200: z.looseObject({ schedules: z.array(scheduleEntrySchema) }),
    ...AUTH_ERRORS,
    404: errorSchema,
  },
});

export const createScheduleContract = defineApiContract({
  method: 'post',
  summary: 'Schedule a flag change',
  description: 'In a protected environment an entry is added through a change request.',
  tags: ['Schedules'],
  requestPathParamsSchema: environmentPathParamsSchema,
  pathResolver: (params) => schedulesPath(params),
  requestHeaderSchema: authHeadersSchema,
  requestBodySchema: scheduleEntryInputSchema,
  responsesByStatusCode: { 201: scheduleEntrySchema, ...CONTENT_WRITE_ERRORS },
});

export const cancelScheduleContract = defineApiContract({
  method: 'delete',
  summary: 'Cancel a pending schedule entry',
  tags: ['Schedules'],
  requestPathParamsSchema: schedulePathParamsSchema,
  pathResolver: (params) => `${schedulesPath(params)}/${params.schedule}`,
  requestHeaderSchema: authHeadersSchema,
  responsesByStatusCode: {
    204: noBodyResponse({ description: 'Cancelled.' }),
    ...AUTH_ERRORS,
    404: errorSchema,
    409: errorSchema,
  },
});
