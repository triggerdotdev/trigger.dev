import { json, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { type GetProjectEnvResponse } from "@trigger.dev/core/v3";
import { z } from "zod";
import { env as processEnv } from "~/env.server";
import {
  authenticatedEnvironmentForAuthentication,
  branchNameFromRequest,
} from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import {
  authenticateEnvironmentScopedApiRequest,
  authorizePatEnvironmentAccess,
  presentedApiKeyFromAuthentication,
} from "~/services/environmentVariableApiAccess.server";

const ParamsSchema = z.object({
  projectRef: z.string(),
  env: z.enum(["dev", "staging", "prod", "preview"]),
});

type ParamsSchema = z.infer<typeof ParamsSchema>;

export async function loader({ request, params }: LoaderFunctionArgs) {
  const parsedParams = ParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    return json({ error: "Invalid Params" }, { status: 400 });
  }

  const { projectRef, env } = parsedParams.data;

  try {
    // PAT/OAT authenticate on the legacy path; machine API keys go through
    // the RBAC controller so additional keys (and their grants) are enforced.
    const authResult = await authenticateEnvironmentScopedApiRequest(request, "read", "apiKeys");
    if (!authResult.ok) {
      return json({ error: authResult.error }, { status: authResult.status });
    }
    const authenticationResult = authResult.authentication;

    const environment = await authenticatedEnvironmentForAuthentication(
      authenticationResult,
      projectRef,
      env,
      branchNameFromRequest(request)
    );

    // User tokens bootstrap the environment's secret key, so gate them on
    // env-tier read:apiKeys. Machine credentials are checked against the same
    // permission before their presented key is returned below.
    const denied = await authorizePatEnvironmentAccess({
      request,
      authType: authenticationResult.type,
      ability:
        authenticationResult.type === "apiKey" && authenticationResult.result.ok
          ? authenticationResult.result.ability
          : undefined,
      organizationId: environment.organizationId,
      projectId: environment.project.id,
      envType: environment.type,
      resource: "apiKeys",
      action: "read",
    });
    if (denied) return denied;

    // API-key callers already possess a valid environment credential. Reuse
    // exactly what they presented instead of exchanging it for the root key.
    const presentedApiKey = presentedApiKeyFromAuthentication(authenticationResult);

    const result: GetProjectEnvResponse = {
      apiKey: presentedApiKey ?? environment.apiKey,
      name: environment.project.name,
      apiUrl: processEnv.API_ORIGIN ?? processEnv.APP_ORIGIN,
      projectId: environment.project.id,
    };

    return json(result);
  } catch (error) {
    if (error instanceof Response) throw error;
    logger.error("Failed to load project env", { error });
    return json({ error: "Internal Server Error" }, { status: 500 });
  }
}
