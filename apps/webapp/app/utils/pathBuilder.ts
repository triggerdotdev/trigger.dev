import type { Integration, TriggerSource } from "@trigger.dev/database";
import { z } from "zod";
import { Job } from "~/models/job.server";
import type { Organization } from "~/models/organization.server";
import type { Project } from "~/models/project.server";

export type OrgForPath = Pick<Organization, "slug">;
export type ProjectForPath = Pick<Project, "slug">;
export type JobForPath = Pick<Job, "slug">;
export type RunForPath = Pick<Job, "id">;
export type IntegrationForPath = Pick<Integration, "slug">;
export type TriggerForPath = Pick<TriggerSource, "id">;

export const OrganizationParamsSchema = z.object({
  organizationSlug: z.string(),
});

export const ProjectParamSchema = OrganizationParamsSchema.extend({
  projectParam: z.string(),
});

export const JobParamsSchema = ProjectParamSchema.extend({
  jobParam: z.string(),
});

export const RunParamsSchema = JobParamsSchema.extend({
  runParam: z.string(),
});

export const TaskParamsSchema = RunParamsSchema.extend({
  taskParam: z.string(),
});

export const IntegrationClientParamSchema = ProjectParamSchema.extend({
  clientParam: z.string(),
});

export const TriggerSourceParamSchema = ProjectParamSchema.extend({
  triggerParam: z.string(),
});

export const TriggerSourceRunParamsSchema = TriggerSourceParamSchema.extend({
  runParam: z.string(),
});

export const TriggerSourceRunTaskParamsSchema = TriggerSourceRunParamsSchema.extend({
  taskParam: z.string(),
});

export function trimTrailingSlash(path: string) {
  return path.replace(/\/$/, "");
}

export function parentPath(path: string) {
  const trimmedTrailingSlash = trimTrailingSlash(path);
  const lastSlashIndex = trimmedTrailingSlash.lastIndexOf("/");
  return trimmedTrailingSlash.substring(0, lastSlashIndex);
}

export function organizationsPath() {
  return `/`;
}

export function accountPath() {
  return `/account`;
}

export function invitesPath() {
  return `/invites`;
}

export function confirmBasicDetailsPath() {
  return `/confirm-basic-details`;
}

export function acceptInvitePath(token: string) {
  return `/invite-accept?token=${token}`;
}

export function resendInvitePath() {
  return `/invite-resend`;
}

export function logoutPath() {
  return `/logout`;
}

// Org
export function organizationPath(organization: OrgForPath) {
  return `/orgs/${organizationParam(organization)}`;
}

export function newOrganizationPath() {
  return `/orgs/new`;
}

export function organizationTeamPath(organization: OrgForPath) {
  return `${organizationPath(organization)}/team`;
}

export function inviteTeamMemberPath(organization: OrgForPath) {
  return `${organizationPath(organization)}/invite`;
}

export function organizationBillingPath(organization: OrgForPath) {
  return `${organizationPath(organization)}/billing`;
}

function organizationParam(organization: OrgForPath) {
  return organization.slug;
}

// Project
export function projectPath(organization: OrgForPath, project: ProjectForPath) {
  return `/orgs/${organizationParam(organization)}/projects/${projectParam(project)}`;
}

export function projectJobsPath(organization: OrgForPath, project: ProjectForPath) {
  return projectPath(organization, project);
}

export function projectIntegrationsPath(organization: OrgForPath, project: ProjectForPath) {
  return `${projectPath(organization, project)}/integrations`;
}

export function projectTriggersPath(organization: OrgForPath, project: ProjectForPath) {
  return `${projectPath(organization, project)}/triggers`;
}

export function projectEnvironmentsPath(organization: OrgForPath, project: ProjectForPath) {
  return `${projectPath(organization, project)}/environments`;
}

export function projectStreamingPath(id: string) {
  return `/resources/projects/${id}/jobs/stream`;
}

export function projectEnvironmentsStreamingPath(
  organization: OrgForPath,
  project: ProjectForPath
) {
  return `${projectEnvironmentsPath(organization, project)}/stream`;
}

export function endpointStreamingPath(environment: { id: string }) {
  return `/resources/environments/${environment.id}/endpoint/stream`;
}

export function newProjectPath(organization: OrgForPath) {
  return `${organizationPath(organization)}/projects/new`;
}

function projectParam(project: ProjectForPath) {
  return project.slug;
}

// Integration
export function integrationClientPath(
  organization: OrgForPath,
  project: ProjectForPath,
  client: IntegrationForPath
) {
  return `${projectIntegrationsPath(organization, project)}/${clientParam(client)}`;
}

export function integrationClientConnectionsPath(
  organization: OrgForPath,
  project: ProjectForPath,
  client: IntegrationForPath
) {
  return `${integrationClientPath(organization, project, client)}/connections`;
}

export function integrationClientScopesPath(
  organization: OrgForPath,
  project: ProjectForPath,
  client: IntegrationForPath
) {
  return `${integrationClientPath(organization, project, client)}/scopes`;
}

function clientParam(integration: IntegrationForPath) {
  return integration.slug;
}

// Triggers
export function projectScheduledTriggersPath(organization: OrgForPath, project: ProjectForPath) {
  return `${projectTriggersPath(organization, project)}/scheduled`;
}

export function externalTriggerPath(
  organization: OrgForPath,
  project: ProjectForPath,
  trigger: TriggerForPath
) {
  return `${projectTriggersPath(organization, project)}/external/${triggerSourceParam(trigger)}`;
}

export function externalTriggerRunsParentPath(
  organization: OrgForPath,
  project: ProjectForPath,
  trigger: TriggerForPath
) {
  return `${externalTriggerPath(organization, project, trigger)}/runs`;
}

export function externalTriggerRunPath(
  organization: OrgForPath,
  project: ProjectForPath,
  trigger: TriggerForPath,
  run: RunForPath
) {
  return `${externalTriggerRunsParentPath(organization, project, trigger)}/${run.id}`;
}

export function externalTriggerRunStreamingPath(
  organization: OrgForPath,
  project: ProjectForPath,
  trigger: TriggerForPath,
  run: RunForPath
) {
  return `${externalTriggerRunPath(organization, project, trigger, run)}/stream`;
}

function triggerSourceParam(trigger: TriggerForPath) {
  return trigger.id;
}

// Job
export function jobPath(organization: OrgForPath, project: ProjectForPath, job: JobForPath) {
  return `${projectPath(organization, project)}/jobs/${jobParam(job)}`;
}

export function jobTestPath(organization: OrgForPath, project: ProjectForPath, job: JobForPath) {
  return `${jobPath(organization, project, job)}/test`;
}

export function jobTriggerPath(organization: OrgForPath, project: ProjectForPath, job: JobForPath) {
  return `${jobPath(organization, project, job)}/trigger`;
}

export function jobSettingsPath(
  organization: OrgForPath,
  project: ProjectForPath,
  job: JobForPath
) {
  return `${jobPath(organization, project, job)}/settings`;
}

export function jobParam(job: JobForPath) {
  return job.slug;
}

// Run
export function jobRunsParentPath(
  organization: OrgForPath,
  project: ProjectForPath,
  job: JobForPath
) {
  return `${jobPath(organization, project, job)}/runs`;
}

export function runPath(
  organization: OrgForPath,
  project: ProjectForPath,
  job: JobForPath,
  run: RunForPath
) {
  return `${jobRunsParentPath(organization, project, job)}/${runParam(run)}`;
}

export function jobRunDashboardPath(
  organization: OrgForPath,
  project: ProjectForPath,
  job: JobForPath,
  run: RunForPath
) {
  return runTriggerPath(runPath(organization, project, job, run));
}

export function runStreamingPath(
  organization: OrgForPath,
  project: ProjectForPath,
  job: JobForPath,
  run: RunForPath
) {
  return `${runPath(organization, project, job, run)}/stream`;
}

export function runParam(run: RunForPath) {
  return run.id;
}

// Task
export function runTaskPath(runPath: string, taskId: string) {
  return `${runPath}/tasks/${taskId}`;
}

// Event
export function runTriggerPath(runPath: string) {
  return `${runPath}/trigger`;
}

// Event
export function runCompletedPath(runPath: string) {
  return `${runPath}/completed`;
}

// Docs
export function docsRoot() {
  return "https://trigger.dev/docs";
}

export function docsPath(path: string) {
  return `${docsRoot()}/${path}`;
}

export function docsIntegrationPath(api: string) {
  return `${docsRoot()}/integrations/apis/${api}`;
}

export function docsCreateIntegration() {
  return `${docsRoot()}/integrations/create`;
}
