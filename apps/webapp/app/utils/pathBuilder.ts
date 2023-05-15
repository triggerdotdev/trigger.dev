import type { Organization } from "~/models/organization.server";
import type { Project } from "~/models/project.server";

type OrgForPath = Pick<Organization, "slug">;
type ProjectForPath = Pick<Project, "id">;

export function accountPath() {
  return `/account`;
}

export function organizationPath(organization: OrgForPath) {
  return `/orgs/${organizationParam(organization)}`;
}

export function newOrganizationPath() {
  return `/orgs/new`;
}

export function organizationIntegrationsPath(organization: OrgForPath) {
  return `${organizationPath(organization)}/integrations`;
}

export function organizationTeamPath(organization: OrgForPath) {
  return `${organizationPath(organization)}/team`;
}

export function organizationBillingPath(organization: OrgForPath) {
  return `${organizationPath(organization)}/team`;
}

export function projectPath(organization: OrgForPath, project: ProjectForPath) {
  return `/orgs/${organizationParam(organization)}/projects/${projectParam(
    project
  )}`;
}

export function newProjectPath(organization: OrgForPath) {
  return `${organizationPath(organization)}/projects/new`;
}

export function organizationParam(organization: OrgForPath) {
  return organization.slug;
}

export function projectParam(project: ProjectForPath) {
  return project.id;
}
