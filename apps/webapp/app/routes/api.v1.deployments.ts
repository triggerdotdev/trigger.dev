import { ActionFunctionArgs, json } from "@remix-run/server-runtime";
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

  const authenticatedEnv = authenticationResult.environment;

  const service = new InitializeDeploymentService();

  const { deployment, imageTag } = await service.call(authenticatedEnv);

  return json(
    {
      id: deployment.friendlyId,
      shortCode: deployment.shortCode,
      version: deployment.version,
      externalBuildData: deployment.externalBuildData,
      imageTag,
    },
    { status: 200 }
  );
}
