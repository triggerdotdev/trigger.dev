import {
  v3EnvironmentPath,
  type EnvironmentForPath,
  type OrgForPath,
  type ProjectForPath,
} from "~/utils/pathBuilder";

export function sessionPathFor(
  organization: OrgForPath,
  project: ProjectForPath,
  environment: EnvironmentForPath
): string {
  return `/resources${v3EnvironmentPath(organization, project, environment)}/dashboard-agent`;
}

const ENVIRONMENT_PATH = /\/orgs\/[^/]+\/projects\/[^/]+\/env\/[^/]+/;

/**
 * False while the hooks still hold the project the browser has already left. Pages outside
 * an environment carry no scope of their own, so they never contradict the hooks.
 */
export function scopeMatchesPath(pathname: string, sessionPath: string): boolean {
  const page = ENVIRONMENT_PATH.exec(pathname);
  if (!page || page.index !== 0) return true;
  return page[0] === ENVIRONMENT_PATH.exec(sessionPath)?.[0];
}
