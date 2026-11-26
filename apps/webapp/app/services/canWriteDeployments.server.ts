import type { rbac } from "~/services/rbac.server";
import { checkPermissions } from "~/services/routeBuilders/permissions.server";

/**
 * Whether the signed-in user may change deployments in the organization (promote, roll back, set
 * a skew protection threshold), from the session the loader already authenticated. Display only,
 * for pages outside Deployments that offer one of those actions: the resource route's
 * `authorization` block is the real check. Matches the Deployments page, including its permissive
 * answer when the session can't be resolved.
 */
export function canWriteDeployments(
  auth: Awaited<ReturnType<typeof rbac.authenticateSession>>
): boolean {
  if (!auth.ok) return true;
  return checkPermissions(auth.ability, {
    canWriteDeployments: { action: "write", resource: { type: "deployments" } },
  }).canWriteDeployments;
}
