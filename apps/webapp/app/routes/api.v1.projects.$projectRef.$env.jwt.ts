import { type ActionFunctionArgs, json } from "@remix-run/node";
import { generateJWT as internal_generateJWT } from "@trigger.dev/core/v3";
import { z } from "zod";
import {
  authenticatedEnvironmentForAuthentication,
  branchNameFromRequest,
} from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { authorizePatEnvironmentAccess } from "~/services/environmentVariableApiAccess.server";
import { authenticateUatOrApiRequest } from "~/services/uatRoutePreamble.server";
import { rbac } from "~/services/rbac.server";
import {
  assertUserActorEnvironment,
  clampUserActorScopes,
} from "~/services/userActorEnvironment.server";

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
    // A user-actor token authenticates as its user, like a PAT. Its scope cap ceilings the
    // minted env JWT below.
    const authentication = await authenticateUatOrApiRequest(request);

    if (!authentication) {
      return json({ error: "Invalid or Missing Access Token" }, { status: 401 });
    }

    const { authenticationResult, userActor } = authentication;
    const userActorId = userActor?.userId;

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

    // The exchange only ever mints for the environment the token was signed for.
    assertUserActorEnvironment(userActor, runtimeEnv.id);

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

    // The env JWT carries scopes only — downstream auth builds its ability from them with no role
    // context. So for a user-actor token the ceiling is the actor's own ability (role floor ∩ the
    // token's cap), never the request: a delegated token can't mint a credential more capable than
    // itself, and a capless token is read-only rather than unbounded. A PAT passes through, gated
    // by the env-tier check above.
    const requestedScopes = parsedBody.data.claims?.scopes;
    let scopes = requestedScopes;

    if (userActor) {
      const actorAuth = await rbac.authenticateUserActor(request, {
        organizationId: runtimeEnv.organizationId,
        projectId: runtimeEnv.project.id,
      });
      if (!actorAuth.ok) {
        return json({ error: actorAuth.error }, { status: actorAuth.status });
      }

      const clamped = clampUserActorScopes(requestedScopes, userActor, actorAuth.ability);
      if (clamped.scopes.length === 0) {
        return json(
          { error: "This token isn't allowed the requested scopes", scopes: clamped.deniedScopes },
          { status: 403 }
        );
      }
      scopes = clamped.scopes;
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
    const actorClient = userActor?.client ?? "personal-access-token";

    const claims = {
      sub: runtimeEnv.id,
      pub: true,
      ...(scopes ? { scopes } : {}),
      ...(actorUserId ? { act: { sub: actorUserId, client: actorClient } } : {}),
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
