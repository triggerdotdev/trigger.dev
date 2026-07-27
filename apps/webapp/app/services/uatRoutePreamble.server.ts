import { isUserActorToken, verifyUserActorToken, type UserActorClaims } from "@trigger.dev/rbac";
import { env } from "~/env.server";
import { authenticateRequest, type AuthenticationResult } from "~/services/apiAuth.server";

/**
 * Shared auth preamble for the handful of `api.v1` routes that accept a delegated
 * user-actor token (`tr_uat_…`) as well as a PAT / org access token.
 *
 * `authenticateRequest` deliberately does NOT accept UATs — a UAT is only valid
 * on routes that opted in — so each of those routes resolved the token itself.
 * That preamble was identical in every copy, so it lives here once.
 *
 * A UAT authenticates as its user, exactly like a PAT (identity-only), so the
 * returned `AuthenticationResult` is the `personalAccessToken` shape and every
 * downstream env lookup / ability check behaves the same. `userActor` is set only
 * on the UAT path, carrying the token's scope cap for routes that ceiling a grant
 * by it (the env-JWT exchange).
 *
 * Returns `undefined` for no token, an unparseable token, and an invalid or
 * expired UAT alike — callers answer all of them with the same 401.
 */
export type UatAuthentication = {
  authenticationResult: AuthenticationResult;
  /** Present only when the caller presented a user-actor token. */
  userActor?: UserActorClaims;
};

export async function authenticateUatOrApiRequest(
  request: Request
): Promise<UatAuthentication | undefined> {
  const bearer = request.headers
    .get("Authorization")
    ?.replace(/^Bearer /, "")
    .trim();

  if (bearer && isUserActorToken(bearer)) {
    const claims = await verifyUserActorToken(env.SESSION_SECRET, bearer);
    if (!claims) return undefined;
    return {
      // The env lookup keys purely on the user, identical to a PAT.
      authenticationResult: { type: "personalAccessToken", result: { userId: claims.userId } },
      userActor: claims,
    };
  }

  const authenticationResult = await authenticateRequest(request, {
    personalAccessToken: true,
    organizationAccessToken: true,
    apiKey: false,
  });
  if (!authenticationResult) return undefined;

  return { authenticationResult };
}
