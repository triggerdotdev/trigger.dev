import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import {
  type GenerateRegistryCredentialsResponseBody,
  ProgressDeploymentRequestBody,
  tryCatch,
} from "@trigger.dev/core/v3";
import { z } from "zod";
import { authenticateRequest } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { DeploymentService } from "~/v3/services/deployment.server";

const ParamsSchema = z.object({
  deploymentId: z.string(),
});

export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method.toUpperCase() !== "POST") {
    return json({ error: "Method Not Allowed" }, { status: 405 });
  }

  const parsedParams = ParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    return json({ error: "Invalid params" }, { status: 400 });
  }

  const authenticationResult = await authenticateRequest(request, {
    apiKey: true,
    organizationAccessToken: false,
    personalAccessToken: false,
  });

  if (!authenticationResult || !authenticationResult.result.ok) {
    logger.info("Invalid or missing api key", { url: request.url });
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  const { environment: authenticatedEnv } = authenticationResult.result;
  const { deploymentId } = parsedParams.data;

  const [, rawBody] = await tryCatch(request.json());
  const body = ProgressDeploymentRequestBody.safeParse(rawBody ?? {});

  if (!body.success) {
    return json({ error: "Invalid request body", issues: body.error.issues }, { status: 400 });
  }

  const deploymentService = new DeploymentService();

  return await deploymentService.generateRegistryCredentials(authenticatedEnv, deploymentId).match(
    (result) => {
      return json(
        {
          username: result.username,
          password: result.password,
          expiresAt: result.expiresAt.toISOString(),
          repositoryUri: result.repositoryUri,
        } satisfies GenerateRegistryCredentialsResponseBody,
        { status: 200 }
      );
    },
    (error) => {
      switch (error.type) {
        case "deployment_not_found":
          return json({ error: "Deployment not found" }, { status: 404 });
        case "deployment_has_no_image_reference":
          logger.error(
            "Failed to generate registry credentials: deployment_has_no_image_reference",
            { deploymentId }
          );
          return json({ error: "Deployment has no image reference" }, { status: 409 });
        case "deployment_is_already_final":
          return json(
            { error: "Failed to generate registry credentials: deployment_is_already_final" },
            { status: 409 }
          );
        case "missing_registry_credentials":
          logger.error("Failed to generate registry credentials: missing_registry_credentials", {
            deploymentId,
          });
          return json({ error: "Missing registry credentials" }, { status: 409 });
        case "registry_not_supported":
          logger.error("Failed to generate registry credentials: registry_not_supported", {
            deploymentId,
          });
          return json({ error: "Registry not supported" }, { status: 409 });
        case "registry_region_not_supported":
          logger.error("Failed to generate registry credentials: registry_region_not_supported", {
            deploymentId,
          });
          return json({ error: "Registry region not supported" }, { status: 409 });
        case "other":
        default:
          error.type satisfies "other";
          logger.error("Failed to generate registry credentials", { error: error.cause });
          return json({ error: "Internal server error" }, { status: 500 });
      }
    }
  );
}
