import { json } from "@remix-run/server-runtime";
import { type UserActorClaims } from "@trigger.dev/rbac";

/** The code returned when a token's environment scope doesn't cover the requested environment. */
export const FORBIDDEN_ENVIRONMENT_CODE = "forbidden_environment";

/**
 * A user-actor token is signed for one environment. Honouring it against another environment
 * would break that signed scope, widening a leaked token to every environment its user can reach.
 *
 * Throws a 403 Response on mismatch. A caller with no `environmentId` claim (a PAT, an org token,
 * or an environment-agnostic UAT flow) is unaffected.
 */
export function assertUserActorEnvironment(
  userActor: UserActorClaims | undefined,
  environmentId: string
): void {
  if (!userActor?.environmentId) return;
  if (userActor.environmentId === environmentId) return;

  throw json(
    {
      error: "This token isn't scoped to that environment.",
      code: FORBIDDEN_ENVIRONMENT_CODE,
    },
    { status: 403 }
  );
}
