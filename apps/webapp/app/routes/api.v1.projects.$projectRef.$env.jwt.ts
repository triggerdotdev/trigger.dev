import { type ActionFunctionArgs, json } from "@remix-run/node";
import { generateJWT as internal_generateJWT } from "@trigger.dev/core/v3";
import {
  buildJwtAbility,
  CAPLESS_USER_ACTOR_SCOPES,
  isUserActorToken,
  scopesWithinAbility,
  verifyUserActorToken,
  type UserActorClaims,
} from "@trigger.dev/rbac";
import parseDuration from "parse-duration";
import { z } from "zod";
import {
  authenticatedEnvironmentForAuthentication,
  authenticateRequest,
  branchNameFromRequest,
  type AuthenticationResult,
} from "~/services/apiAuth.server";
import { env as appEnv } from "~/env.server";
import { assertUserActorEnvironmentAccess } from "~/services/userActorEnvironment.server";
import { assertSourcePatActive } from "~/services/personalAccessToken.server";
import { logger } from "~/services/logger.server";
import { authorizePatEnvironmentAccess } from "~/services/environmentVariableApiAccess.server";

const ParamsSchema = z.object({
  projectRef: z.string(),
  env: z.enum(["dev", "staging", "prod", "preview"]),
});

const RequestBodySchema = z.object({
  claims: z
    .object({
      scopes: z.array(z.string()).default([]),
    })
    .optional(),
  expirationTime: z.union([z.number(), z.string()]).optional(),
});

// A requested `expirationTime` above this (epoch seconds, ~2001) is an absolute
// timestamp; a smaller number is a relative offset in seconds.
const EXPIRY_EPOCH_THRESHOLD_SECONDS = 1_000_000_000;
const DEFAULT_EXPIRY = "1h";

// Resolve the requested expiry to an absolute epoch-second timestamp so it can be
// clamped against a delegated token's own expiry.
function resolveRequestedExpirySeconds(
  expirationTime: number | string | undefined,
  nowSec: number
): number {
  if (typeof expirationTime === "number") {
    return expirationTime > EXPIRY_EPOCH_THRESHOLD_SECONDS
      ? expirationTime
      : nowSec + expirationTime;
  }
  const durationMs = parseDuration(expirationTime ?? DEFAULT_EXPIRY);
  const seconds = durationMs != null ? Math.floor(durationMs / 1000) : 60 * 60;
  return nowSec + seconds;
}

export async function action({ request, params }: ActionFunctionArgs) {
  try {
    const bearer = request.headers
      .get("Authorization")
      ?.replace(/^Bearer /, "")
      .trim();
    const isUat = !!bearer && isUserActorToken(bearer);

    // A delegated user-actor token authenticates as its user, like a PAT. We
    // resolve it here (not through authenticateRequest) so the exchange stays
    // scoped to this route — UATs deliberately aren't accepted on every
    // PAT route. `uatCap` (the token's optional scope cap) ceilings the
    // minted env JWT below.
    let uatCap: string[] | undefined;
    let userActorId: string | undefined;
    let userActor: UserActorClaims | undefined;
    let authenticationResult: AuthenticationResult | undefined;
    if (isUat) {
      const claims = await verifyUserActorToken(appEnv.SESSION_SECRET, bearer!);
      if (!claims) {
        return json({ error: "Invalid or Missing Access Token" }, { status: 401 });
      }
      // A token minted from a PAT dies with it — the PAT must still be live.
      if (!(await assertSourcePatActive(claims))) {
        return json({ error: "Invalid or Missing Access Token" }, { status: 401 });
      }
      uatCap = claims.cap;
      userActorId = claims.userId;
      userActor = claims;
      // The env lookup keys purely on the user, identical to a PAT.
      authenticationResult = {
        type: "personalAccessToken",
        result: { userId: claims.userId },
      };
    } else {
      authenticationResult = await authenticateRequest(request, {
        personalAccessToken: true,
        organizationAccessToken: true,
        apiKey: false,
      });
    }

    if (!authenticationResult) {
      return json({ error: "Invalid or Missing Access Token" }, { status: 401 });
    }

    const parsedParams = ParamsSchema.safeParse(params);

    if (!parsedParams.success) {
      return json({ error: "Invalid Params" }, { status: 400 });
    }

    const { projectRef, env } = parsedParams.data;
    const triggerBranch = branchNameFromRequest(request);

    const runtimeEnv = await authenticatedEnvironmentForAuthentication(
      authenticationResult,
      projectRef,
      env,
      triggerBranch
    );

    // A user-actor token signed for one environment mints only for that one; one signed for an
    // organization mints for any environment of that org its user is a member of.
    await assertUserActorEnvironmentAccess(userActor, runtimeEnv);

    // This mints a JWT signed with the environment's secret key. For a PAT
    // (a user), gate it on env-tier read:apiKeys so a restricted role can't
    // obtain deployed-environment credentials (and therefore can't deploy).
    const denied = await authorizePatEnvironmentAccess({
      request,
      authType: authenticationResult.type,
      organizationId: runtimeEnv.organizationId,
      projectId: runtimeEnv.project.id,
      envType: runtimeEnv.type,
      resource: "apiKeys",
      action: "read",
    });
    if (denied) return denied;

    const parsedBody = RequestBodySchema.safeParse(await request.json());

    if (!parsedBody.success) {
      return json(
        { error: "Invalid request body", issues: parsedBody.error.issues },
        { status: 400 }
      );
    }

    // The env JWT carries scopes only — downstream auth builds its ability
    // from them with no role context. So for a user-actor token we ceiling
    // the scopes here (a read-only agent token can't widen its grant through
    // the exchange) and stamp the user via `act` so the minted env JWT stays
    // attributable. A capless token's ceiling is read-only, never full access.
    // The ceiling is applied through the scope grammar, not literal membership:
    // `read:all` is a wildcard no literal request string equals, so a literal
    // filter against it would wrongly deny every read.
    const requestedScopes = parsedBody.data.claims?.scopes;
    let scopes: string[] | undefined;
    if (isUat) {
      const ceiling = uatCap && uatCap.length > 0 ? uatCap : CAPLESS_USER_ACTOR_SCOPES;
      const ability = buildJwtAbility(ceiling);
      const scopeGranted = (scope: string) => scopesWithinAbility([scope], ability).ok;
      scopes =
        requestedScopes && requestedScopes.length > 0
          ? requestedScopes.filter(scopeGranted)
          : ceiling;
    } else {
      scopes = requestedScopes;
    }

    // Attribution: stamp the acting user on the minted env JWT. A UAT carries
    // its user as `userActorId`; a PAT exchange resolves the user from the
    // authentication result. Either way downstream handlers read `act.sub`
    // (e.g. the errors API records who resolved/ignored an error). An org
    // access token has no user, so `act` is omitted.
    const actorUserId =
      userActorId ??
      (authenticationResult.type === "personalAccessToken"
        ? authenticationResult.result.userId
        : undefined);

    const claims = {
      sub: runtimeEnv.id,
      pub: true,
      ...(scopes ? { scopes } : {}),
      ...(actorUserId
        ? { act: { sub: actorUserId, client: userActor?.client ?? "personal-access-token" } }
        : {}),
    };

    // A delegated token can't mint a longer-lived JWT than itself: clamp the
    // requested expiry to the token's own `exp`. Non-UAT callers are unchanged.
    const nowSec = Math.floor(Date.now() / 1000);
    const requestedAbsSec = resolveRequestedExpirySeconds(parsedBody.data.expirationTime, nowSec);
    const expirationTime =
      isUat && userActor?.expiresAt !== undefined
        ? Math.min(requestedAbsSec, userActor.expiresAt)
        : (parsedBody.data.expirationTime ?? DEFAULT_EXPIRY);

    const jwt = await internal_generateJWT({
      secretKey: runtimeEnv.apiKey,
      payload: claims,
      expirationTime,
    });

    return json({ token: jwt });
  } catch (error) {
    if (error instanceof Response) throw error;
    logger.error("Failed to generate env JWT", { error });
    return json({ error: "Internal Server Error" }, { status: 500 });
  }
}
