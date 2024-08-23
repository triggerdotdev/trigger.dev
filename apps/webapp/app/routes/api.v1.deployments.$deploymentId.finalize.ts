import { ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { FinalizeDeploymentRequestBody } from "@trigger.dev/core/v3";
import { z } from "zod";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import { FinalizeDeploymentService } from "~/v3/services/finalizeDeployment.server";

const ParamsSchema = z.object({
  deploymentId: z.string(),
});

export async function action({ request, params }: ActionFunctionArgs) {
  // Ensure this is a POST request
  if (request.method.toUpperCase() !== "POST") {
    return { status: 405, body: "Method Not Allowed" };
  }

  const parsedParams = ParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    return json({ error: "Invalid params" }, { status: 400 });
  }

  // Next authenticate the request
  const authenticationResult = await authenticateApiRequest(request);

  if (!authenticationResult) {
    logger.info("Invalid or missing api key", { url: request.url });
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  const authenticatedEnv = authenticationResult.environment;

  const { deploymentId } = parsedParams.data;

  const rawBody = await request.json();
  const body = FinalizeDeploymentRequestBody.safeParse(rawBody);

  if (!body.success) {
    return json({ error: "Invalid body", issues: body.error.issues }, { status: 400 });
  }

  try {
    const service = new FinalizeDeploymentService();
    await service.call(authenticatedEnv, deploymentId, body.data);

    return json(
      {
        id: deploymentId,
      },
      { status: 200 }
    );
  } catch (error) {
    if (error instanceof ServiceValidationError) {
      return json({ error: error.message }, { status: 400 });
    } else if (error instanceof Error) {
      logger.error("Error finalizing deployment", { error: error.message });
      return json({ error: `Internal server error: ${error.message}` }, { status: 500 });
    } else {
      logger.error("Error finalizing deployment", { error: String(error) });
      return json({ error: "Internal server error" }, { status: 500 });
    }
  }
}
