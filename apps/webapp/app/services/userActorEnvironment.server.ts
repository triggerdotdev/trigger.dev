import { json } from "@remix-run/server-runtime";
import { type UserActorClaims } from "@trigger.dev/rbac";
import { $replica } from "~/db.server";

/** The code returned when a token's environment scope doesn't cover the requested environment. */
export const FORBIDDEN_ENVIRONMENT_CODE = "forbidden_environment";

/** The agent always mints per-environment, so a claimless token of its own is a bug, not a flow. */
const DASHBOARD_AGENT_CLIENT = "dashboard-agent";

/**
 * A user-actor token is signed for one environment. Honouring it against another environment
 * would break that signed scope, widening a leaked token to every environment its user can reach.
 *
 * Throws a 403 Response on mismatch. A PAT, an org token or an environment-agnostic UAT flow
 * (the public PAT exchange, used by MCP and the CLI) carries no claim and is unaffected — but a
 * dashboard-agent token without one is refused, so a mint that failed to resolve an environment
 * cannot produce a token that passes every gate.
 */
export function assertUserActorEnvironment(
  userActor: UserActorClaims | undefined,
  environmentId: string
): void {
  if (!userActor) return;
  if (!userActor.environmentId) {
    assertClaimIsOptional(userActor);
    return;
  }
  if (userActor.environmentId === environmentId) return;

  throw forbiddenEnvironment("This token isn't scoped to that environment.");
}

/**
 * The same check for a route that names an org/project rather than one environment — the shape a
 * route builder's `context` resolves. A token signed for one environment may only act inside that
 * environment's project and org, so a URL naming a different tenant fails closed here rather than
 * relying on each route to notice.
 */
export async function assertUserActorScope(
  userActor: UserActorClaims | undefined,
  scope: { organizationId?: string; projectId?: string; environmentId?: string }
): Promise<void> {
  if (!userActor) return;

  if (!userActor.environmentId) {
    assertClaimIsOptional(userActor);
    return;
  }

  if (scope.environmentId) {
    assertUserActorEnvironment(userActor, scope.environmentId);
    return;
  }

  if (!scope.organizationId && !scope.projectId) return;

  const environment = await $replica.runtimeEnvironment.findFirst({
    where: { id: userActor.environmentId },
    select: { organizationId: true, projectId: true },
  });

  // A claim naming an environment that no longer exists cannot be checked, so it isn't honoured.
  if (!environment) {
    throw forbiddenEnvironment("This token isn't scoped to an environment.");
  }
  if (scope.projectId && environment.projectId !== scope.projectId) {
    throw forbiddenEnvironment("This token isn't scoped to that project.");
  }
  if (scope.organizationId && environment.organizationId !== scope.organizationId) {
    throw forbiddenEnvironment("This token isn't scoped to that organization.");
  }
}

/** A dashboard-agent token always carries the claim; any other flow may be environment-agnostic. */
function assertClaimIsOptional(userActor: UserActorClaims): void {
  if (userActor.client !== DASHBOARD_AGENT_CLIENT) return;
  throw forbiddenEnvironment("This token isn't scoped to an environment.");
}

function forbiddenEnvironment(error: string) {
  return json({ error, code: FORBIDDEN_ENVIRONMENT_CODE }, { status: 403 });
}
