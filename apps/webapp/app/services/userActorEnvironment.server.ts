import { json } from "@remix-run/server-runtime";
import { type UserActorClaims } from "@trigger.dev/rbac";

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
    if (userActor.client !== DASHBOARD_AGENT_CLIENT) return;
    throw json(
      { error: "This token isn't scoped to an environment.", code: FORBIDDEN_ENVIRONMENT_CODE },
      { status: 403 }
    );
  }
  if (userActor.environmentId === environmentId) return;

  throw json(
    {
      error: "This token isn't scoped to that environment.",
      code: FORBIDDEN_ENVIRONMENT_CODE,
    },
    { status: 403 }
  );
}
