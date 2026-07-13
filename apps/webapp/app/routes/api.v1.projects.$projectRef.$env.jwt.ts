import { type ActionFunctionArgs, json } from "@remix-run/node";
import { generateJWT as internal_generateJWT } from "@trigger.dev/core/v3";
import { isUserActorToken, verifyUserActorToken } from "@trigger.dev/rbac";
import { z } from "zod";
import {
  authenticatedEnvironmentForAuthentication,
  authenticateRequest,
  branchNameFromRequest,
  type AuthenticationResult,
} from "~/services/apiAuth.server";
import { env as appEnv } from "~/env.server";
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
    let authenticationResult: AuthenticationResult | undefined;
    if (isUat) {
      const claims = await verifyUserActorToken(appEnv.SESSION_SECRET, bearer!);
      if (!claims) {
        return json({ error: "Invalid or Missing Access Token" }, { status: 401 });
      }
      uatCap = claims.cap;
      userActorId = claims.userId;
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
    // the scopes by the token's own cap here (a read-only agent token can't
    // widen its grant through the exchange) and stamp the user via `act` so
    // the minted env JWT stays attributable. The cap is a ceiling, not a
    // replacement: intersect what the caller asked for with the cap (or use
    // the full cap if they asked for nothing). No cap → the request passes
    // through, same as a PAT.
    const requestedScopes = parsedBody.data.claims?.scopes;
    const scopes =
      isUat && uatCap
        ? requestedScopes && requestedScopes.length > 0
          ? requestedScopes.filter((scope) => uatCap.includes(scope))
          : uatCap
        : requestedScopes;

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
      ...(actorUserId ? { act: { sub: actorUserId } } : {}),
    };

    const jwt = await internal_generateJWT({
      secretKey: runtimeEnv.apiKey,
      payload: claims,
      expirationTime: parsedBody.data.expirationTime ?? "1h",
    });

    return json({ token: jwt });
  } catch (error) {
    if (error instanceof Response) throw error;
    logger.error("Failed to generate env JWT", { error });
    return json({ error: "Internal Server Error" }, { status: 500 });
  }
}
