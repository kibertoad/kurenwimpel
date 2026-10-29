import { describeApiContract, resolveStatusEntry } from '@toad-contracts/core';
import { describe, expect, it } from 'vitest';
import * as z from 'zod/mini';

import {
  authHeadersSchema,
  CONTROL_PLANE_CONTRACTS,
  getFlagContract,
  ifMatchHeadersSchema,
  updateFlagContract,
} from '../src/index.js';

const ENV = '/api/v1/orgs/:org/projects/:project/environments/:env';

/** Written out by hand, so a path change has to change this table too. */
const EXPECTED_ROUTES: Record<keyof typeof CONTROL_PLANE_CONTRACTS, string> = {
  getOrganisation: 'GET /api/v1/orgs/:org',
  listProjects: 'GET /api/v1/orgs/:org/projects',
  createProject: 'POST /api/v1/orgs/:org/projects',
  listEnvironments: 'GET /api/v1/orgs/:org/projects/:project/environments',
  createEnvironment: 'POST /api/v1/orgs/:org/projects/:project/environments',
  getEnvironment: `GET ${ENV}`,
  updateEnvironment: `PATCH ${ENV}`,
  listFlags: `GET ${ENV}/flags`,
  getFlag: `GET ${ENV}/flags/:flag`,
  createFlag: `POST ${ENV}/flags`,
  updateFlag: `PUT ${ENV}/flags/:flag`,
  deleteFlag: `DELETE ${ENV}/flags/:flag`,
  listFlagVersions: `GET ${ENV}/flags/:flag/versions`,
  listSegments: `GET ${ENV}/segments`,
  getSegment: `GET ${ENV}/segments/:segment`,
  createSegment: `POST ${ENV}/segments`,
  updateSegment: `PUT ${ENV}/segments/:segment`,
  updateSegmentMembers: `POST ${ENV}/segments/:segment/members`,
  deleteSegment: `DELETE ${ENV}/segments/:segment`,
  listChangeRequests: `GET ${ENV}/change-requests`,
  createChangeRequest: `POST ${ENV}/change-requests`,
  getChangeRequest: `GET ${ENV}/change-requests/:changeRequest`,
  updateChangeRequest: `PUT ${ENV}/change-requests/:changeRequest`,
  reviewChangeRequest: `POST ${ENV}/change-requests/:changeRequest/reviews`,
  applyChangeRequest: `POST ${ENV}/change-requests/:changeRequest/apply`,
  closeChangeRequest: `POST ${ENV}/change-requests/:changeRequest/close`,
  listAuditEvents: 'GET /api/v1/orgs/:org/audit-events',
  getPublication: `GET ${ENV}/publication`,
  publish: `POST ${ENV}/publish`,
  listRevisions: `GET ${ENV}/revisions`,
  rollback: `POST ${ENV}/rollback`,
  exportDocument: `GET ${ENV}/document`,
  importDocument: `POST ${ENV}/import`,
  listSchedules: `GET ${ENV}/schedules`,
  createSchedule: `POST ${ENV}/schedules`,
  cancelSchedule: `DELETE ${ENV}/schedules/:schedule`,
  listSdkKeys: `GET ${ENV}/sdk-keys`,
  createSdkKey: `POST ${ENV}/sdk-keys`,
  revokeSdkKey: `DELETE ${ENV}/sdk-keys/:sdkKey`,
};

const contracts = Object.entries(CONTROL_PLANE_CONTRACTS);

describe('routes', () => {
  it.each(contracts)('%s maps to its documented path', (name, contract) => {
    expect(describeApiContract(contract)).toBe(
      EXPECTED_ROUTES[name as keyof typeof CONTROL_PLANE_CONTRACTS],
    );
  });

  it('resolves a concrete path', () => {
    const params = { org: 'acme', project: 'shop', env: 'production', flag: 'new-checkout' };
    expect(getFlagContract.pathResolver(params)).toBe(
      '/api/v1/orgs/acme/projects/shop/environments/production/flags/new-checkout',
    );
  });

  it.each(contracts)('%s answers 401 and 403 with an error body', (_name, contract) => {
    expect(resolveStatusEntry(contract.responsesByStatusCode, 401)).toBeDefined();
    expect(resolveStatusEntry(contract.responsesByStatusCode, 403)).toBeDefined();
  });

  it.each(contracts)('%s requires a bearer token', (_name, contract) => {
    expect(z.safeParse(contract.requestHeaderSchema, {}).success).toBe(false);
  });

  it('rejects path params that are not slugs or keys', () => {
    const schema = getFlagContract.requestPathParamsSchema;
    const valid = { org: 'acme', project: 'shop', env: 'production', flag: 'new-checkout' };
    expect(z.safeParse(schema, valid).success).toBe(true);
    expect(z.safeParse(schema, { ...valid, org: 'Acme' }).success).toBe(false);
    expect(z.safeParse(schema, { ...valid, flag: 'a/b' }).success).toBe(false);
    expect(z.safeParse(schema, { ...valid, flag: '' }).success).toBe(false);
  });
});

describe('headers', () => {
  it('accepts a bearer token and keeps headers it does not declare', () => {
    const result = z.safeParse(authHeadersSchema, {
      authorization: 'Bearer t',
      'x-request-id': 'r1',
    });
    expect(result.data).toEqual({ authorization: 'Bearer t', 'x-request-id': 'r1' });
  });

  it('rejects a scheme other than bearer', () => {
    expect(z.safeParse(authHeadersSchema, { authorization: 'Basic dTpw' }).success).toBe(false);
  });

  it('requires if-match as a quoted version on a replacing write', () => {
    expect(updateFlagContract.requestHeaderSchema).toBe(ifMatchHeadersSchema);
    const auth = 'Bearer t';
    expect(
      z.safeParse(ifMatchHeadersSchema, { authorization: auth, 'if-match': '"3"' }).success,
    ).toBe(true);
    for (const ifMatch of ['3', '"0"', '"03"', 'W/"3"', '*']) {
      expect(
        z.safeParse(ifMatchHeadersSchema, { authorization: auth, 'if-match': ifMatch }).success,
      ).toBe(false);
    }
    expect(z.safeParse(ifMatchHeadersSchema, { authorization: auth }).success).toBe(false);
  });
});
