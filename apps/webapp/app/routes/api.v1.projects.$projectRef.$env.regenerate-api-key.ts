import type { ActionFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { regenerateApiKey } from "~/models/api-key.server";
import {
  authenticatedEnvironmentForAuthentication,
  authenticateRequest,
  branchNameFromRequest,
} from "~/services/apiAuth.server";
import { authorizePatEnvironmentAccess } from "~/services/environmentVariableApiAccess.server";
import { logger } from "~/services/logger.server";

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

    // Rotating the key requires env-tier write:apiKeys — same gate the
    // dashboard resource route enforces.
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

    const updatedEnvironment = await regenerateApiKey({
      userId: authenticationResult.result.userId,
      environmentId: environment.id,
    });

    return json({ apiKey: updatedEnvironment.apiKey });
  } catch (error) {
    if (error instanceof Response) throw error;
    logger.error("Failed to regenerate API key", { error });
    return json({ error: "Internal Server Error" }, { status: 500 });
  }
}
