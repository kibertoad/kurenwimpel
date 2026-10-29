/**
 * Path params and path builders. Every resource below an environment is
 * addressed as `/api/v1/orgs/:org/projects/:project/environments/:env/...`.
 *
 * `withObjectKeys` is what lets `mapApiContractToPath` learn the param names.
 */

import { withObjectKeys } from '@toad-contracts/zod';
import * as z from 'zod/mini';

import { CONTROL_PLANE_BASE_PATH, idSchema, resourceKeySchema, slugSchema } from './common.js';

const orgShape = { org: slugSchema };
const projectShape = { ...orgShape, project: slugSchema };
const environmentShape = { ...projectShape, env: slugSchema };

export const orgPathParamsSchema = withObjectKeys(z.object(orgShape));
export const projectPathParamsSchema = withObjectKeys(z.object(projectShape));
export const environmentPathParamsSchema = withObjectKeys(z.object(environmentShape));
export const flagPathParamsSchema = withObjectKeys(
  z.object({ ...environmentShape, flag: resourceKeySchema }),
);
export const segmentPathParamsSchema = withObjectKeys(
  z.object({ ...environmentShape, segment: resourceKeySchema }),
);
export const changeRequestPathParamsSchema = withObjectKeys(
  z.object({ ...environmentShape, changeRequest: idSchema }),
);
export const schedulePathParamsSchema = withObjectKeys(
  z.object({ ...environmentShape, schedule: idSchema }),
);
export const sdkKeyPathParamsSchema = withObjectKeys(
  z.object({ ...environmentShape, sdkKey: idSchema }),
);

export interface OrgPathParams {
  readonly org: string;
}

export interface ProjectPathParams extends OrgPathParams {
  readonly project: string;
}

export interface EnvironmentPathParams extends ProjectPathParams {
  readonly env: string;
}

export function orgPath({ org }: OrgPathParams): string {
  return `${CONTROL_PLANE_BASE_PATH}/orgs/${org}`;
}

export function projectPath(params: ProjectPathParams): string {
  return `${orgPath(params)}/projects/${params.project}`;
}

export function environmentPath(params: EnvironmentPathParams): string {
  return `${projectPath(params)}/environments/${params.env}`;
}
