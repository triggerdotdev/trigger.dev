import { json, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { BuildRuntime, type GetProjectEnvResponse } from "@trigger.dev/core/v3";
import { z } from "zod";
import { env as processEnv } from "~/env.server";
import {
  authenticatedEnvironmentForAuthentication,
  branchNameFromRequest,
} from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import {
  apiKeyForProjectEnvironmentBootstrap,
  authenticateEnvironmentBootstrapRequest,
  authorizePatEnvironmentAccess,
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
    // PAT/OAT authenticate on the legacy path; machine API keys only need to
    // prove they are valid because bootstrap echoes the same key back.
    const authResult = await authenticateEnvironmentBootstrapRequest(request);
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
    // env-tier read:apiKeys. A machine credential never receives that root key.
    if (authenticationResult.type !== "apiKey") {
      const denied = await authorizePatEnvironmentAccess({
        request,
        authType: authenticationResult.type,
        organizationId: environment.organizationId,
        projectId: environment.project.id,
        envType: environment.type,
        resource: "apiKeys",
        action: "read",
      });
      if (denied) return denied;
    }

    const result: GetProjectEnvResponse = {
      apiKey: apiKeyForProjectEnvironmentBootstrap(authenticationResult, environment.apiKey),
      name: environment.project.name,
      apiUrl: processEnv.API_ORIGIN ?? processEnv.APP_ORIGIN,
      projectId: environment.project.id,
      defaultRuntime: BuildRuntime.nullable().parse(environment.project.defaultRuntime ?? null),
    };

    return json(result);
  } catch (error) {
    if (error instanceof Response) throw error;
    logger.error("Failed to load project env", { error });
    return json({ error: "Internal Server Error" }, { status: 500 });
  }
}
