import type { ActionFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import {
  authenticatedEnvironmentForAuthentication,
  authenticateRequest,
  branchNameFromRequest,
} from "~/services/apiAuth.server";
import { authorizePatEnvironmentAccess } from "~/services/environmentVariableApiAccess.server";
import { logger } from "~/services/logger.server";
import { PauseEnvironmentService } from "~/v3/services/pauseEnvironment.server";

const ParamsSchema = z.object({
  projectRef: z.string(),
  env: z.enum(["dev", "staging", "prod", "preview"]),
});

export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method.toUpperCase() !== "POST") {
    return json({ error: "Method Not Allowed" }, { status: 405 });
  }

  const parsedParams = ParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    return json({ error: "Invalid Params" }, { status: 400 });
  }

  const { projectRef, env } = parsedParams.data;

  try {
    const authenticationResult = await authenticateRequest(request, {
      personalAccessToken: true,
      organizationAccessToken: false,
      apiKey: false,
    });

    if (!authenticationResult) {
      return json({ error: "Invalid or Missing Access Token" }, { status: 401 });
    }

    const environment = await authenticatedEnvironmentForAuthentication(
      authenticationResult,
      projectRef,
      env,
      branchNameFromRequest(request)
    );

    // Same env-tier gate as the regenerate-api-key route: managing an
    // environment's operational state is an env-admin action.
    const denied = await authorizePatEnvironmentAccess({
      request,
      authType: authenticationResult.type,
      organizationId: environment.organizationId,
      projectId: environment.project.id,
      envType: environment.type,
      resource: "apiKeys",
      action: "write",
    });
    if (denied) return denied;

    const result = await new PauseEnvironmentService().call(environment, "resumed");

    if (!result.success) {
      return json({ error: result.error }, { status: 400 });
    }

    return json({ paused: false, state: result.state });
  } catch (error) {
    if (error instanceof Response) throw error;
    logger.error("Failed to resume environment", { error });
    return json({ error: "Internal Server Error" }, { status: 500 });
  }
}
