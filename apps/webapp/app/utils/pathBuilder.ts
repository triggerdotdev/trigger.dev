import { Job } from "~/models/job.server";
import type { Organization } from "~/models/organization.server";
import type { Project } from "~/models/project.server";

type OrgForPath = Pick<Organization, "slug">;
type ProjectForPath = Pick<Project, "slug">;
type JobForPath = Pick<Job, "id">;

export function accountPath() {
  return `/account`;
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

export function organizationBillingPath(organization: OrgForPath) {
  return `${organizationPath(organization)}/team`;
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

export function testJobPath(
  organization: OrgForPath,
  project: ProjectForPath,
  job: JobForPath
) {
  return `${jobPath(organization, project, job)}/test`;
}

export function jobParam(job: JobForPath) {
  return job.id;
}

// Docs
const docsRoot = "https://docs.trigger.dev";

export function docsPath(path: string) {
  return `${docsRoot}${path}`;
}
