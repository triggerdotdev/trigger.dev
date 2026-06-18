import { json, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { type GetProjectEnvResponse } from "@trigger.dev/core/v3";
import { z } from "zod";
import { env as processEnv } from "~/env.server";
import {
  authenticatedEnvironmentForAuthentication,
  authenticateRequest,
  branchNameFromRequest,
} from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { authorizePatEnvironmentAccess } from "~/services/environmentVariableApiAccess.server";

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
    const authenticationResult = await authenticateRequest(request, {
      personalAccessToken: true,
      organizationAccessToken: true,
      apiKey: true,
    });

    if (!authenticationResult) {
      return json({ error: "Invalid or Missing API key" }, { status: 401 });
    }

    const environment = await authenticatedEnvironmentForAuthentication(
      authenticationResult,
      projectRef,
      env,
      branchNameFromRequest(request)
    );

    // This endpoint hands the caller the environment's secret key. For a PAT
    // (a user), gate it on env-tier read:apiKeys — so a restricted role can't
    // pull deployed credentials (and therefore can't deploy) via the CLI.
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

    const result: GetProjectEnvResponse = {
      apiKey: environment.apiKey,
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
