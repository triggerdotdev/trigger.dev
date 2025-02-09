import { ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import { ChangeCurrentDeploymentService } from "~/v3/services/changeCurrentDeployment.server";

const ParamsSchema = z.object({
  deploymentVersion: z.string(),
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

  const { deploymentVersion } = parsedParams.data;

  const deployment = await prisma.workerDeployment.findFirst({
    where: {
      version: deploymentVersion,
      environmentId: authenticatedEnv.id,
    },
  });

  if (!deployment) {
    return json({ error: "Deployment not found" }, { status: 404 });
  }

  try {
    const service = new ChangeCurrentDeploymentService();
    await service.call(deployment, "promote");

    return json(
      {
        id: deployment.friendlyId,
        version: deployment.version,
        shortCode: deployment.shortCode,
      },
      { status: 200 }
    );
  } catch (error) {
    if (error instanceof ServiceValidationError) {
      return json({ error: error.message }, { status: 400 });
    } else {
      return json({ error: "Failed to promote deployment" }, { status: 500 });
    }
  }
}
