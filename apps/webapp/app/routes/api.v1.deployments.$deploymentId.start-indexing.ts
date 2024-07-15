import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { StartDeploymentIndexingRequestBody } from '@trigger.dev/core/v3/schemas';
import { z } from "zod";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { StartDeploymentIndexing } from "~/v3/services/startDeploymentIndexing.server";

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
  const body = StartDeploymentIndexingRequestBody.safeParse(rawBody);

  if (!body.success) {
    return json({ error: "Invalid body", issues: body.error.issues }, { status: 400 });
  }

  const service = new StartDeploymentIndexing();

  const deployment = await service.call(authenticatedEnv, deploymentId, body.data);

  return json(
    {
      id: deployment.friendlyId,
      contentHash: deployment.contentHash,
    },
    { status: 200 }
  );
}
