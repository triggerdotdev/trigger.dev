import type { ActionFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import {
  BulkDeleteEnvironmentVariablesRequestBody,
  type BulkDeleteEnvironmentVariablesResponseBody,
} from "@trigger.dev/core/v3";
import { z } from "zod";
import {
  authenticatedEnvironmentForAuthentication,
  branchNameFromRequest,
} from "~/services/apiAuth.server";
import {
  authenticateEnvVarApiRequest,
  authorizeEnvVarApiRequest,
} from "~/services/environmentVariableApiAccess.server";
import { logger } from "~/services/logger.server";
import { EnvironmentVariablesRepository } from "~/v3/environmentVariables/environmentVariablesRepository.server";

const ParamsSchema = z.object({
  projectRef: z.string(),
  slug: z.string(),
});

export async function action({ params, request }: ActionFunctionArgs) {
  if (request.method.toUpperCase() !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  const parsedParams = ParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    return json({ error: "Invalid params" }, { status: 400 });
  }

  try {
    const authResult = await authenticateEnvVarApiRequest(request, "write");
    if (!authResult.ok) {
      return json({ error: authResult.error }, { status: authResult.status });
    }
    const authenticationResult = authResult.authentication;

    const environment = await authenticatedEnvironmentForAuthentication(
      authenticationResult,
      parsedParams.data.projectRef,
      parsedParams.data.slug,
      branchNameFromRequest(request)
    );

    const denied = await authorizeEnvVarApiRequest({
      request,
      authType: authenticationResult.type,
      ability:
        authenticationResult.type === "apiKey" && authenticationResult.result.ok
          ? authenticationResult.result.ability
          : undefined,
      organizationId: environment.organizationId,
      projectId: environment.project.id,
      envType: environment.type,
      action: "write",
    });
    if (denied) return denied;

    const rawBody = await request.json().catch(() => undefined);
    const body = BulkDeleteEnvironmentVariablesRequestBody.safeParse(rawBody);

    if (!body.success) {
      return json({ error: "Invalid request body", issues: body.error.issues }, { status: 400 });
    }

    const repository = new EnvironmentVariablesRepository();

    const result: BulkDeleteEnvironmentVariablesResponseBody = await repository.deleteValues(
      environment.project.id,
      {
        environmentId: environment.id,
        keys: body.data.keys,
        onlyWrittenBy: body.data.onlyWrittenBy,
        onlyShadowingParent: body.data.onlyShadowingParent,
      }
    );

    return json(result);
  } catch (error) {
    if (error instanceof Response) throw error;
    logger.error("Failed to bulk delete environment variables", {
      error,
      projectRef: params.projectRef,
    });
    return json({ error: "Internal Server Error" }, { status: 500 });
  }
}
