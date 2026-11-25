import { CliApiClient } from "../apiClient.js";
import { isTriggerCloudApi } from "../utilities/apiUrl.js";
import type { ProjectIds } from "./telemetry.js";

export type ResolvedAuth = { apiUrl: string; accessToken: string };

// Not a lookup result: callers must not cache it.
export const NO_CREDENTIALS = Symbol("no-credentials");

// An auth that resolves after clear() belongs to the old profile and is dropped.
export function createAuthHolder() {
  let current: ResolvedAuth | undefined;
  let epoch = 0;
  return {
    get: () => current,
    begin: () => epoch,
    set(token: number, auth: ResolvedAuth) {
      if (token !== epoch) return false;
      current = auth;
      return true;
    },
    clear() {
      epoch += 1;
      current = undefined;
    },
  };
}

async function fetchProjectIds(auth: ResolvedAuth, projectRef: string) {
  const result = await new CliApiClient(auth.apiUrl, auth.accessToken).getProject(projectRef);
  if (!result.success) return undefined;
  return { organizationId: result.data.organization.id, projectId: result.data.id };
}

// Uses only credentials a tool call already resolved, so it never starts a login.
export function createProjectLookup(deps: {
  resolvedAuth: () => ResolvedAuth | undefined;
  getProject?: (auth: ResolvedAuth, projectRef: string) => Promise<ProjectIds | undefined>;
}) {
  const getProject = deps.getProject ?? fetchProjectIds;
  return async (projectRef: string) => {
    const auth = deps.resolvedAuth();
    return auth && isTriggerCloudApi(auth.apiUrl) ? getProject(auth, projectRef) : NO_CREDENTIALS;
  };
}
