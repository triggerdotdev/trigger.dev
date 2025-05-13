import type { RuntimeEnvironment, TaskRun, WorkerDeployment } from "@trigger.dev/database";
import { z } from "zod";
import { type TaskRunListSearchFilters } from "~/components/runs/v3/RunFilters";
import type { Organization } from "~/models/organization.server";
import type { Project } from "~/models/project.server";
import { objectToSearchParams } from "./searchParams";
import { type WaitpointSearchParams } from "~/components/runs/v3/WaitpointTokenFilters";
export type OrgForPath = Pick<Organization, "slug">;
export type ProjectForPath = Pick<Project, "slug">;
export type EnvironmentForPath = Pick<RuntimeEnvironment, "slug">;
export type v3RunForPath = Pick<TaskRun, "friendlyId">;
export type v3SpanForPath = Pick<TaskRun, "spanId">;
export type DeploymentForPath = Pick<WorkerDeployment, "shortCode">;
export type TaskForPath = {
  taskIdentifier: string;
};

export const OrganizationParamsSchema = z.object({
  organizationSlug: z.string(),
});

export const ProjectParamSchema = OrganizationParamsSchema.extend({
  projectParam: z.string(),
});

export const EnvironmentParamSchema = ProjectParamSchema.extend({
  envParam: z.string(),
});

//v3
export const v3TaskParamsSchema = EnvironmentParamSchema.extend({
  taskParam: z.string(),
});

export const v3RunParamsSchema = EnvironmentParamSchema.extend({
  runParam: z.string(),
});

export const v3SpanParamsSchema = v3RunParamsSchema.extend({
  spanParam: z.string(),
});

export const v3DeploymentParams = EnvironmentParamSchema.extend({
  deploymentParam: z.string(),
});

export const v3ScheduleParams = EnvironmentParamSchema.extend({
  scheduleParam: z.string(),
});

export function rootPath() {
  return `/`;
}

export function accountPath() {
  return `/account`;
}

export function personalAccessTokensPath() {
  return `/account/tokens`;
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

export function revokeInvitePath() {
  return `/invite-revoke`;
}

// Org
export function organizationPath(organization: OrgForPath) {
  return `/orgs/${organizationParam(organization)}`;
}

export function newOrganizationPath() {
  return `/orgs/new`;
}

export function selectPlanPath(organization: OrgForPath) {
  return `${organizationPath(organization)}/select-plan`;
}

export function organizationTeamPath(organization: OrgForPath) {
  return `${organizationPath(organization)}/settings/team`;
}

export function inviteTeamMemberPath(organization: OrgForPath) {
  return `${organizationPath(organization)}/invite`;
}

export function organizationBillingPath(organization: OrgForPath) {
  return `${organizationPath(organization)}/billing`;
}

export function organizationSettingsPath(organization: OrgForPath) {
  return `${organizationPath(organization)}/settings`;
}

function organizationParam(organization: OrgForPath) {
  return organization.slug;
}

// Project
export function newProjectPath(organization: OrgForPath, message?: string) {
  return `${organizationPath(organization)}/projects/new${
    message ? `?message=${encodeURIComponent(message)}` : ""
  }`;
}

function projectParam(project: ProjectForPath) {
  return project.slug;
}

function environmentParam(environment: EnvironmentForPath) {
  return environment.slug;
}

//v3 project
export function v3ProjectPath(organization: OrgForPath, project: ProjectForPath) {
  return `/orgs/${organizationParam(organization)}/projects/${projectParam(project)}`;
}

export function v3EnvironmentPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath
) {
  return `/orgs/${organizationParam(organization)}/projects/${projectParam(
    project
  )}/env/${environmentParam(environment)}`;
}

export function v3TasksStreamingPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath
) {
  return `${v3EnvironmentPath(organization, project, environment)}/tasks/stream`;
}

export function v3ApiKeysPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath
) {
  return `${v3EnvironmentPath(organization, project, environment)}/apikeys`;
}

export function v3EnvironmentVariablesPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath
) {
  return `${v3EnvironmentPath(organization, project, environment)}/environment-variables`;
}

export function v3NewEnvironmentVariablesPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath
) {
  return `${v3EnvironmentVariablesPath(organization, project, environment)}/new`;
}

export function v3ProjectAlertsPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath
) {
  return `${v3EnvironmentPath(organization, project, environment)}/alerts`;
}

export function v3NewProjectAlertPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath
) {
  return `${v3ProjectAlertsPath(organization, project, environment)}/new`;
}

export function v3NewProjectAlertPathConnectToSlackPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath
) {
  return `${v3ProjectAlertsPath(organization, project, environment)}/new/connect-to-slack`;
}

export function v3TestPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath
) {
  return `${v3EnvironmentPath(organization, project, environment)}/test`;
}

export function v3TestTaskPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath,
  task: TaskForPath
) {
  return `${v3TestPath(organization, project, environment)}/tasks/${encodeURIComponent(
    task.taskIdentifier
  )}`;
}

export function v3RunsPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath,
  filters?: TaskRunListSearchFilters
) {
  const searchParams = objectToSearchParams(filters);
  const query = searchParams ? `?${searchParams.toString()}` : "";
  return `${v3EnvironmentPath(organization, project, environment)}/runs${query}`;
}

export function v3RunPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath,
  run: v3RunForPath
) {
  return `${v3RunsPath(organization, project, environment)}/${run.friendlyId}`;
}

export function v3RunRedirectPath(
  organization: OrgForPath,
  project: ProjectForPath,
  run: v3RunForPath
) {
  return `${v3ProjectPath(organization, project)}/runs/${run.friendlyId}`;
}

export function v3RunDownloadLogsPath(run: v3RunForPath) {
  return `/resources/runs/${run.friendlyId}/logs/download`;
}

export function v3RunSpanPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath,
  run: v3RunForPath,
  span: v3SpanForPath
) {
  return `${v3RunPath(organization, project, environment, run)}?span=${span.spanId}`;
}

export function v3RunStreamingPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath,
  run: v3RunForPath
) {
  return `${v3RunPath(organization, project, environment, run)}/stream`;
}

export function v3SchedulesPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath
) {
  return `${v3EnvironmentPath(organization, project, environment)}/schedules`;
}

export function v3SchedulePath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath,
  schedule: { friendlyId: string }
) {
  return `${v3EnvironmentPath(organization, project, environment)}/schedules/${
    schedule.friendlyId
  }`;
}

export function v3EditSchedulePath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath,
  schedule: { friendlyId: string }
) {
  return `${v3EnvironmentPath(organization, project, environment)}/schedules/edit/${
    schedule.friendlyId
  }`;
}

export function v3NewSchedulePath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath
) {
  return `${v3EnvironmentPath(organization, project, environment)}/schedules/new`;
}

export function v3QueuesPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath
) {
  return `${v3EnvironmentPath(organization, project, environment)}/queues`;
}

export function v3WaitpointTokensPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath,
  filters?: WaitpointSearchParams
) {
  const searchParams = objectToSearchParams(filters);
  const query = searchParams ? `?${searchParams.toString()}` : "";
  return `${v3EnvironmentPath(organization, project, environment)}/waitpoints/tokens${query}`;
}

export function v3WaitpointTokenPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath,
  token: { id: string },
  filters?: WaitpointSearchParams
) {
  const searchParams = objectToSearchParams(filters);
  const query = searchParams ? `?${searchParams.toString()}` : "";
  return `${v3WaitpointTokensPath(organization, project, environment)}/${token.id}${query}`;
}

export function v3BatchesPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath
) {
  return `${v3EnvironmentPath(organization, project, environment)}/batches`;
}

export function v3BatchPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath,
  batch: { friendlyId: string }
) {
  return `${v3EnvironmentPath(organization, project, environment)}/batches?id=${batch.friendlyId}`;
}

export function v3BatchRunsPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath,
  batch: { friendlyId: string }
) {
  return `${v3RunsPath(organization, project, environment, { batchId: batch.friendlyId })}`;
}

export function v3ProjectSettingsPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath
) {
  return `${v3EnvironmentPath(organization, project, environment)}/settings`;
}

export function v3DeploymentsPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath
) {
  return `${v3EnvironmentPath(organization, project, environment)}/deployments`;
}

export function v3DeploymentPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath,
  deployment: DeploymentForPath,
  currentPage: number
) {
  const query = currentPage ? `?page=${currentPage}` : "";
  return `${v3DeploymentsPath(organization, project, environment)}/${deployment.shortCode}${query}`;
}

export function v3DeploymentVersionPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath,
  version: string
) {
  return `${v3DeploymentsPath(organization, project, environment)}?version=${version}`;
}

export function branchesPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath
) {
  return `${v3EnvironmentPath(organization, project, environment)}/branches`;
}

export function v3BillingPath(organization: OrgForPath, message?: string) {
  return `${organizationPath(organization)}/settings/billing${
    message ? `?message=${encodeURIComponent(message)}` : ""
  }`;
}

export function v3StripePortalPath(organization: OrgForPath) {
  return `/resources/${organization.slug}/subscription/portal`;
}

export function v3UsagePath(organization: OrgForPath) {
  return `${organizationPath(organization)}/settings/usage`;
}

// Docs
export function docsRoot() {
  return "https://trigger.dev/docs";
}

export function docsPath(path: string) {
  return `${docsRoot()}/${path}`;
}

export function docsTroubleshootingPath(path: string) {
  return `${docsRoot()}/v3/troubleshooting`;
}

export function adminPath() {
  return `/@`;
}
