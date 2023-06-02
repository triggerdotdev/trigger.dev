import { Job } from "~/models/job.server";
import type { Organization } from "~/models/organization.server";
import type { Project } from "~/models/project.server";

type OrgForPath = Pick<Organization, "slug">;
type ProjectForPath = Pick<Project, "slug">;
type JobForPath = Pick<Job, "id">;
type RunForPath = Pick<Job, "id">;

export function organizationsPath() {
  return `/`;
}

export function accountPath() {
  return `/account`;
}

export function invitesPath() {
  return `/invites`;
}

export function acceptInvitePath(token: string) {
  return `/accept-invite?token=${token}`;
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
  return `/orgs/${organizationParam(organization)}/projects/${projectParam(
    project
  )}`;
}

export function projectIntegrationsPath(
  organization: OrgForPath,
  project: ProjectForPath
) {
  return `${projectPath(organization, project)}/integrations`;
}

export function projectEnvironmentsPath(
  organization: OrgForPath,
  project: ProjectForPath
) {
  return `${projectPath(organization, project)}/environments`;
}

export function newProjectPath(organization: OrgForPath) {
  return `${organizationPath(organization)}/projects/new`;
}

function projectParam(project: ProjectForPath) {
  return project.slug;
}

// Job
export function jobPath(
  organization: OrgForPath,
  project: ProjectForPath,
  job: JobForPath
) {
  return `${projectPath(organization, project)}/jobs/${jobParam(job)}`;
}

export function jobTestPath(
  organization: OrgForPath,
  project: ProjectForPath,
  job: JobForPath
) {
  return `${jobPath(organization, project, job)}/test`;
}

export function jobTriggerPath(
  organization: OrgForPath,
  project: ProjectForPath,
  job: JobForPath
) {
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
  return job.id;
}

// Run
export function runPath(
  organization: OrgForPath,
  project: ProjectForPath,
  job: JobForPath,
  run: RunForPath
) {
  return `${jobPath(organization, project, job)}/runs/${runParam(run)}`;
}

export function runParam(run: RunForPath) {
  return run.id;
}

// Docs
const docsRoot = "https://docs.trigger.dev";

export function docsPath(path: string) {
  return `${docsRoot}${path}`;
}
