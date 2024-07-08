import type {
  BackgroundWorkerTask,
  EventRecord,
  Integration,
  TaskRun,
  TriggerHttpEndpoint,
  TriggerSource,
  Webhook,
  WorkerDeployment,
} from "@trigger.dev/database";
import { z } from "zod";
import { TaskRunListSearchFilters } from "~/components/runs/v3/RunFilters";
import { Job } from "~/models/job.server";
import type { Organization } from "~/models/organization.server";
import type { Project } from "~/models/project.server";
import { objectToSearchParams } from "./searchParams";

export type OrgForPath = Pick<Organization, "slug">;
export type ProjectForPath = Pick<Project, "slug">;
export type JobForPath = Pick<Job, "slug">;
export type RunForPath = Pick<Job, "id">;
export type IntegrationForPath = Pick<Integration, "slug">;
export type TriggerForPath = Pick<TriggerSource, "id">;
export type EventForPath = Pick<EventRecord, "id">;
export type WebhookForPath = Pick<Webhook, "id">;
export type HttpEndpointForPath = Pick<TriggerHttpEndpoint, "key">;
export type TaskForPath = Pick<BackgroundWorkerTask, "friendlyId">;
export type v3RunForPath = Pick<TaskRun, "friendlyId">;
export type v3SpanForPath = Pick<TaskRun, "spanId">;
export type DeploymentForPath = Pick<WorkerDeployment, "shortCode">;

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

export const IntegrationClientParamSchema = OrganizationParamsSchema.extend({
  clientParam: z.string(),
});

export const TriggerSourceParamSchema = ProjectParamSchema.extend({
  triggerParam: z.string(),
});

export const EventParamSchema = ProjectParamSchema.extend({
  eventParam: z.string(),
});

export const TriggerSourceRunParamsSchema = TriggerSourceParamSchema.extend({
  runParam: z.string(),
});

export const TriggerSourceRunTaskParamsSchema = TriggerSourceRunParamsSchema.extend({
  taskParam: z.string(),
});

export const HttpEndpointParamSchema = ProjectParamSchema.extend({
  httpEndpointParam: z.string(),
});

//v3
export const v3TaskParamsSchema = ProjectParamSchema.extend({
  taskParam: z.string(),
});

export const v3RunParamsSchema = ProjectParamSchema.extend({
  runParam: z.string(),
});

export const v3SpanParamsSchema = v3RunParamsSchema.extend({
  spanParam: z.string(),
});

export const v3DeploymentParams = ProjectParamSchema.extend({
  deploymentParam: z.string(),
});

export const v3ScheduleParams = ProjectParamSchema.extend({
  scheduleParam: z.string(),
});

export function trimTrailingSlash(path: string) {
  return path.replace(/\/$/, "");
}

export function parentPath(path: string) {
  const trimmedTrailingSlash = trimTrailingSlash(path);
  const lastSlashIndex = trimmedTrailingSlash.lastIndexOf("/");
  return trimmedTrailingSlash.substring(0, lastSlashIndex);
}

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
  return `${organizationPath(organization)}/team`;
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

export function organizationIntegrationsPath(organization: OrgForPath) {
  return `${organizationPath(organization)}/integrations`;
}

export function usagePath(organization: OrgForPath) {
  return `${organizationPath(organization)}/billing`;
}

export function stripePortalPath(organization: OrgForPath) {
  return `/resources/${organization.slug}/subscription/portal`;
}

export function plansPath(organization: OrgForPath) {
  return `${organizationPath(organization)}/billing/plans`;
}

export function subscribedPath(organization: OrgForPath) {
  return `${organizationPath(organization)}/subscribed`;
}

function organizationParam(organization: OrgForPath) {
  return organization.slug;
}

// Project
export function projectPath(organization: OrgForPath, project: ProjectForPath) {
  return `/orgs/${organizationParam(organization)}/projects/${projectParam(project)}`;
}

export function projectRunsPath(organization: OrgForPath, project: ProjectForPath) {
  return `${projectPath(organization, project)}/runs`;
}

export function projectSetupPath(organization: OrgForPath, project: ProjectForPath) {
  return `${projectPath(organization, project)}/setup`;
}

export function projectSetupNextjsPath(organization: OrgForPath, project: ProjectForPath) {
  return `${projectPath(organization, project)}/setup/nextjs`;
}

export function projectSetupRemixPath(organization: OrgForPath, project: ProjectForPath) {
  return `${projectPath(organization, project)}/setup/remix`;
}

export function projectSetupExpressPath(organization: OrgForPath, project: ProjectForPath) {
  return `${projectPath(organization, project)}/setup/express`;
}

export function projectSetupRedwoodPath(organization: OrgForPath, project: ProjectForPath) {
  return `${projectPath(organization, project)}/setup/redwood`;
}

export function projectSetupNuxtPath(organization: OrgForPath, project: ProjectForPath) {
  return `${projectPath(organization, project)}/setup/nuxt`;
}

export function projectSetupSvelteKitPath(organization: OrgForPath, project: ProjectForPath) {
  return `${projectPath(organization, project)}/setup/sveltekit`;
}

export function projectSetupFastifyPath(organization: OrgForPath, project: ProjectForPath) {
  return `${projectPath(organization, project)}/setup/fastify`;
}

export function projectSetupAstroPath(organization: OrgForPath, project: ProjectForPath) {
  return `${projectPath(organization, project)}/setup/astro`;
}

export function projectSetupNestjsPath(organization: OrgForPath, project: ProjectForPath) {
  return `${projectPath(organization, project)}/setup/nestjs`;
}

export function projectJobsPath(organization: OrgForPath, project: ProjectForPath) {
  return projectPath(organization, project);
}

export function projectTriggersPath(organization: OrgForPath, project: ProjectForPath) {
  return `${projectPath(organization, project)}/triggers`;
}

export function projectEventsPath(organization: OrgForPath, project: ProjectForPath) {
  return `${projectPath(organization, project)}/events`;
}

export function projectSettingsPath(organization: OrgForPath, project: ProjectForPath) {
  return `${projectPath(organization, project)}/settings`;
}

export function projectEventPath(
  organization: OrgForPath,
  project: ProjectForPath,
  event: EventForPath
) {
  return `${projectEventsPath(organization, project)}/${event.id}`;
}

export function projectHttpEndpointsPath(organization: OrgForPath, project: ProjectForPath) {
  return `${projectPath(organization, project)}/http-endpoints`;
}
export function projectHttpEndpointPath(
  organization: OrgForPath,
  project: ProjectForPath,
  httpEndpoint: HttpEndpointForPath
) {
  return `${projectHttpEndpointsPath(organization, project)}/${httpEndpoint.key}`;
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

export function newProjectPath(organization: OrgForPath, message?: string) {
  return `${organizationPath(organization)}/projects/new${
    message ? `?message=${encodeURIComponent(message)}` : ""
  }`;
}

function projectParam(project: ProjectForPath) {
  return project.slug;
}

//v3 project
export function v3ProjectPath(organization: OrgForPath, project: ProjectForPath) {
  return `/orgs/${organizationParam(organization)}/projects/v3/${projectParam(project)}`;
}

export function v3TasksStreamingPath(organization: OrgForPath, project: ProjectForPath) {
  return `${v3ProjectPath(organization, project)}/tasks/stream`;
}

export function v3ApiKeysPath(organization: OrgForPath, project: ProjectForPath) {
  return `${v3ProjectPath(organization, project)}/apikeys`;
}

export function v3EnvironmentVariablesPath(organization: OrgForPath, project: ProjectForPath) {
  return `${v3ProjectPath(organization, project)}/environment-variables`;
}

export function v3NewEnvironmentVariablesPath(organization: OrgForPath, project: ProjectForPath) {
  return `${v3EnvironmentVariablesPath(organization, project)}/new`;
}

export function v3ProjectAlertsPath(organization: OrgForPath, project: ProjectForPath) {
  return `${v3ProjectPath(organization, project)}/alerts`;
}

export function v3NewProjectAlertPath(organization: OrgForPath, project: ProjectForPath) {
  return `${v3ProjectAlertsPath(organization, project)}/new`;
}

export function v3NewProjectAlertPathConnectToSlackPath(
  organization: OrgForPath,
  project: ProjectForPath
) {
  return `${v3ProjectAlertsPath(organization, project)}/new/connect-to-slack`;
}

export function v3TestPath(
  organization: OrgForPath,
  project: ProjectForPath,
  environmentSlug?: string
) {
  return `${v3ProjectPath(organization, project)}/test${
    environmentSlug ? `?environment=${environmentSlug}` : ""
  }`;
}

export function v3TestTaskPath(
  organization: OrgForPath,
  project: ProjectForPath,
  task: TaskForPath,
  environmentSlug: string
) {
  return `${v3TestPath(organization, project)}/tasks/${
    task.friendlyId
  }?environment=${environmentSlug}`;
}

export function v3RunsPath(
  organization: OrgForPath,
  project: ProjectForPath,
  filters?: TaskRunListSearchFilters
) {
  const searchParams = objectToSearchParams(filters);
  const query = searchParams ? `?${searchParams.toString()}` : "";
  return `${v3ProjectPath(organization, project)}/runs${query}`;
}

export function v3RunPath(organization: OrgForPath, project: ProjectForPath, run: v3RunForPath) {
  return `${v3RunsPath(organization, project)}/${run.friendlyId}`;
}

export function v3RunDownloadLogsPath(run: v3RunForPath) {
  return `/resources/runs/${run.friendlyId}/logs/download`;
}

export function v3RunSpanPath(
  organization: OrgForPath,
  project: ProjectForPath,
  run: v3RunForPath,
  span: v3SpanForPath
) {
  return `${v3RunPath(organization, project, run)}?span=${span.spanId}`;
}

export function v3TraceSpanPath(
  organization: OrgForPath,
  project: ProjectForPath,
  traceId: string,
  spanId: string
) {
  return `${v3ProjectPath(organization, project)}/traces/${traceId}/spans/${spanId}`;
}

export function v3RunStreamingPath(
  organization: OrgForPath,
  project: ProjectForPath,
  run: v3RunForPath
) {
  return `${v3RunPath(organization, project, run)}/stream`;
}

export function v3SchedulesPath(organization: OrgForPath, project: ProjectForPath) {
  return `${v3ProjectPath(organization, project)}/schedules`;
}

export function v3SchedulePath(
  organization: OrgForPath,
  project: ProjectForPath,
  schedule: { friendlyId: string }
) {
  return `${v3ProjectPath(organization, project)}/schedules/${schedule.friendlyId}`;
}

export function v3EditSchedulePath(
  organization: OrgForPath,
  project: ProjectForPath,
  schedule: { friendlyId: string }
) {
  return `${v3ProjectPath(organization, project)}/schedules/edit/${schedule.friendlyId}`;
}

export function v3NewSchedulePath(organization: OrgForPath, project: ProjectForPath) {
  return `${v3ProjectPath(organization, project)}/schedules/new`;
}

export function v3ProjectSettingsPath(organization: OrgForPath, project: ProjectForPath) {
  return `${v3ProjectPath(organization, project)}/settings`;
}

export function v3DeploymentsPath(organization: OrgForPath, project: ProjectForPath) {
  return `${v3ProjectPath(organization, project)}/deployments`;
}

export function v3DeploymentPath(
  organization: OrgForPath,
  project: ProjectForPath,
  deployment: DeploymentForPath
) {
  return `${v3DeploymentsPath(organization, project)}/${deployment.shortCode}`;
}

export function v3BillingPath(organization: OrgForPath) {
  return `${organizationPath(organization)}/v3/billing`;
}

export function v3StripePortalPath(organization: OrgForPath) {
  return `/resources/${organization.slug}/subscription/v3/portal`;
}

export function v3UsagePath(organization: OrgForPath) {
  return `${organizationPath(organization)}/v3/usage`;
}

// Integration
export function integrationClientPath(organization: OrgForPath, client: IntegrationForPath) {
  return `${organizationIntegrationsPath(organization)}/${clientParam(client)}`;
}

export function integrationClientConnectionsPath(
  organization: OrgForPath,
  client: IntegrationForPath
) {
  return `${integrationClientPath(organization, client)}/connections`;
}

export function integrationClientScopesPath(organization: OrgForPath, client: IntegrationForPath) {
  return `${integrationClientPath(organization, client)}/scopes`;
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

export function projectWebhookTriggersPath(organization: OrgForPath, project: ProjectForPath) {
  return `${projectTriggersPath(organization, project)}/webhooks`;
}

export function webhookTriggerPath(
  organization: OrgForPath,
  project: ProjectForPath,
  webhook: WebhookForPath
) {
  return `${projectTriggersPath(organization, project)}/webhooks/${webhookSourceParam(webhook)}`;
}

export function webhookTriggerRunsParentPath(
  organization: OrgForPath,
  project: ProjectForPath,
  webhook: WebhookForPath
) {
  return `${webhookTriggerPath(organization, project, webhook)}/runs`;
}

export function webhookTriggerRunPath(
  organization: OrgForPath,
  project: ProjectForPath,
  webhook: WebhookForPath,
  run: RunForPath
) {
  return `${webhookTriggerRunsParentPath(organization, project, webhook)}/${run.id}`;
}

export function webhookTriggerRunStreamingPath(
  organization: OrgForPath,
  project: ProjectForPath,
  webhook: WebhookForPath,
  run: RunForPath
) {
  return `${webhookTriggerRunPath(organization, project, webhook, run)}/stream`;
}

export function webhookDeliveryPath(
  organization: OrgForPath,
  project: ProjectForPath,
  webhook: WebhookForPath
) {
  return `${webhookTriggerPath(organization, project, webhook)}/delivery`;
}

export function webhookTriggerDeliveryRunsParentPath(
  organization: OrgForPath,
  project: ProjectForPath,
  webhook: WebhookForPath
) {
  return `${webhookTriggerRunsParentPath(organization, project, webhook)}/delivery`;
}

export function webhookTriggerDeliveryRunPath(
  organization: OrgForPath,
  project: ProjectForPath,
  webhook: WebhookForPath,
  run: RunForPath
) {
  return `${webhookTriggerDeliveryRunsParentPath(organization, project, webhook)}/${run.id}`;
}

export function webhookTriggerDeliveryRunStreamingPath(
  organization: OrgForPath,
  project: ProjectForPath,
  webhook: WebhookForPath,
  run: RunForPath
) {
  return `${webhookTriggerDeliveryRunPath(organization, project, webhook, run)}/stream`;
}

function webhookSourceParam(webhook: WebhookForPath) {
  return webhook.id;
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

//api
export function apiReferencePath(apiSlug: string) {
  return `https://trigger.dev/apis/${apiSlug}`;
}
