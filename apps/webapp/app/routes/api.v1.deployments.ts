import { ActionFunctionArgs, json } from "@remix-run/server-runtime";
import {
  InitializeDeploymentRequestBody,
  InitializeDeploymentResponseBody,
} from "@trigger.dev/core/v3";
import { env } from "~/env.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { InitializeDeploymentService } from "~/v3/services/initializeDeployment.server";

export async function action({ request, params }: ActionFunctionArgs) {
  // Ensure this is a POST request
  if (request.method.toUpperCase() !== "POST") {
    return { status: 405, body: "Method Not Allowed" };
  }

  // Next authenticate the request
  const authenticationResult = await authenticateApiRequest(request);

  if (!authenticationResult) {
    logger.info("Invalid or missing api key", { url: request.url });
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  const rawBody = await request.json();
  const body = InitializeDeploymentRequestBody.safeParse(rawBody);

  if (!body.success) {
    return json({ error: "Invalid body", issues: body.error.issues }, { status: 400 });
  }

  const authenticatedEnv = authenticationResult.environment;

  const service = new InitializeDeploymentService();

  const { deployment, imageTag } = await service.call(authenticatedEnv, body.data);

  const responseBody: InitializeDeploymentResponseBody = {
    id: deployment.friendlyId,
    contentHash: deployment.contentHash,
    shortCode: deployment.shortCode,
    version: deployment.version,
    externalBuildData:
      deployment.externalBuildData as InitializeDeploymentResponseBody["externalBuildData"],
    imageTag,
    registryHost: body.data.registryHost ?? env.DEPLOY_REGISTRY_HOST,
  };

  return json(responseBody, { status: 200 });
}
