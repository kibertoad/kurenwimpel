import { listAuditEventsContract } from './audit.js';
import {
  applyChangeRequestContract,
  closeChangeRequestContract,
  createChangeRequestContract,
  getChangeRequestContract,
  listChangeRequestsContract,
  reviewChangeRequestContract,
  updateChangeRequestContract,
} from './change-requests.js';
import {
  createFlagContract,
  deleteFlagContract,
  getFlagContract,
  listFlagsContract,
  listFlagVersionsContract,
  updateFlagContract,
} from './flags.js';
import {
  createEnvironmentContract,
  createProjectContract,
  getEnvironmentContract,
  getOrganisationContract,
  listEnvironmentsContract,
  listProjectsContract,
  updateEnvironmentContract,
} from './organisation.js';
import {
  exportDocumentContract,
  getPublicationContract,
  importDocumentContract,
  listRevisionsContract,
  publishContract,
  rollbackContract,
} from './publishing.js';
import {
  cancelScheduleContract,
  createScheduleContract,
  listSchedulesContract,
} from './schedules.js';
import { createSdkKeyContract, listSdkKeysContract, revokeSdkKeyContract } from './sdk-keys.js';
import {
  createSegmentContract,
  deleteSegmentContract,
  getSegmentContract,
  listSegmentsContract,
  updateSegmentContract,
  updateSegmentMembersContract,
} from './segments.js';

/** Every route of the control plane API, for consumers that mount or exercise them as a set. */
export const CONTROL_PLANE_CONTRACTS = {
  getOrganisation: getOrganisationContract,
  listProjects: listProjectsContract,
  createProject: createProjectContract,
  listEnvironments: listEnvironmentsContract,
  createEnvironment: createEnvironmentContract,
  getEnvironment: getEnvironmentContract,
  updateEnvironment: updateEnvironmentContract,
  listFlags: listFlagsContract,
  getFlag: getFlagContract,
  createFlag: createFlagContract,
  updateFlag: updateFlagContract,
  deleteFlag: deleteFlagContract,
  listFlagVersions: listFlagVersionsContract,
  listSegments: listSegmentsContract,
  getSegment: getSegmentContract,
  createSegment: createSegmentContract,
  updateSegment: updateSegmentContract,
  updateSegmentMembers: updateSegmentMembersContract,
  deleteSegment: deleteSegmentContract,
  listChangeRequests: listChangeRequestsContract,
  createChangeRequest: createChangeRequestContract,
  getChangeRequest: getChangeRequestContract,
  updateChangeRequest: updateChangeRequestContract,
  reviewChangeRequest: reviewChangeRequestContract,
  applyChangeRequest: applyChangeRequestContract,
  closeChangeRequest: closeChangeRequestContract,
  listAuditEvents: listAuditEventsContract,
  getPublication: getPublicationContract,
  publish: publishContract,
  listRevisions: listRevisionsContract,
  rollback: rollbackContract,
  exportDocument: exportDocumentContract,
  importDocument: importDocumentContract,
  listSchedules: listSchedulesContract,
  createSchedule: createScheduleContract,
  cancelSchedule: cancelScheduleContract,
  listSdkKeys: listSdkKeysContract,
  createSdkKey: createSdkKeyContract,
  revokeSdkKey: revokeSdkKeyContract,
} as const;
