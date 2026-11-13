import type { Waitpoint } from "@trigger.dev/database";
import { readHttpCallbackScope, verifyScopedHttpCallbackHash } from "./httpCallbackHash.server";

type CallbackEnvironment = {
  id: string;
  apiKey: string;
  parentEnvironment?: { apiKey: string } | null;
  project: { id: string };
  organization: { id: string };
};

/** Authenticate the signed scope and gate its organization before preparing the native read. */
export async function resolveScopedWaitpointCallback<T extends CallbackEnvironment>(
  waitpointId: string,
  hash: string,
  deps: {
    isWaitpointStoreEnabled: (organizationId: string) => Promise<boolean>;
    resolveEnvironment: (environmentId: string) => Promise<T | null>;
    getWaitpoint: (scope: {
      waitpointId: string;
      environmentId: string;
      projectId: string;
      organizationId: string;
    }) => Promise<Waitpoint | null>;
  }
): Promise<{ environment: T; waitpoint: Waitpoint } | { error: string; status: 401 | 404 }> {
  const scope = readHttpCallbackScope(hash);
  if (!scope || scope.waitpointId !== waitpointId) {
    return { error: "Invalid URL, hash doesn't match", status: 401 };
  }
  const environment = await deps.resolveEnvironment(scope.environmentId);
  if (!environment) return { error: "Waitpoint not found", status: 404 };
  if (
    !verifyScopedHttpCallbackHash(
      waitpointId,
      environment.id,
      hash,
      environment.parentEnvironment?.apiKey ?? environment.apiKey
    ) &&
    // Keep callback URLs issued with a branch key before run-token auth was normalized.
    !(
      environment.parentEnvironment &&
      verifyScopedHttpCallbackHash(waitpointId, environment.id, hash, environment.apiKey)
    )
  ) {
    return { error: "Invalid URL, hash doesn't match", status: 401 };
  }
  if (!(await deps.isWaitpointStoreEnabled(environment.organization.id))) {
    return { error: "Waitpoint not found", status: 404 };
  }
  const waitpoint = await deps.getWaitpoint({
    waitpointId,
    environmentId: environment.id,
    projectId: environment.project.id,
    organizationId: environment.organization.id,
  });
  if (!waitpoint) return { error: "Waitpoint not found", status: 404 };
  return { waitpoint, environment };
}
