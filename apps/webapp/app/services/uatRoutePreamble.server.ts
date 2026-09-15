import { isUserActorToken, verifyUserActorToken, type UserActorClaims } from "@trigger.dev/rbac";
import { env } from "~/env.server";
import { authenticateRequest, type AuthenticationResult } from "~/services/apiAuth.server";
import { assertSourcePatActive } from "~/services/personalAccessToken.server";

/**
 * Auth preamble for `api.v1` routes that opt into delegated user-actor tokens alongside a PAT
 * or org token. A UAT authenticates as its user, so the result is the `personalAccessToken` shape.
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
    // A token minted from a PAT dies with it — the PAT must still be live.
    if (!(await assertSourcePatActive(claims))) return undefined;
    return {
      // The claims ride on the authentication result too: resolving an environment from it
      // enforces the token's environment scope, so no route has to remember to.
      authenticationResult: {
        type: "personalAccessToken",
        result: { userId: claims.userId },
        userActor: claims,
      },
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
