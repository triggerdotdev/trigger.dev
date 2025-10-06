import { type LoaderFunctionArgs, json } from "@remix-run/server-runtime";
import { type GetDeploymentResponseBody } from "@trigger.dev/core/v3";
import { z } from "zod";
import { prisma } from "~/db.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";

const ParamsSchema = z.object({
  deploymentId: z.string(),
});

export async function loader({ request, params }: LoaderFunctionArgs) {
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

  const deployment = await prisma.workerDeployment.findFirst({
    where: {
      friendlyId: deploymentId,
      environmentId: authenticatedEnv.id,
    },
    include: {
      worker: {
        include: {
          tasks: true,
        },
      },
    },
  });

  if (!deployment) {
    return json({ error: "Deployment not found" }, { status: 404 });
  }

  return json({
    id: deployment.friendlyId,
    status: deployment.status,
    contentHash: deployment.contentHash,
    shortCode: deployment.shortCode,
    version: deployment.version,
    imageReference: deployment.imageReference,
    imagePlatform: deployment.imagePlatform,
    externalBuildData:
      deployment.externalBuildData as GetDeploymentResponseBody["externalBuildData"],
    errorData: deployment.errorData as GetDeploymentResponseBody["errorData"],
    worker: deployment.worker
      ? {
          id: deployment.worker.friendlyId,
          version: deployment.worker.version,
          tasks: deployment.worker.tasks.map((task) => ({
            id: task.friendlyId,
            slug: task.slug,
            filePath: task.filePath,
            exportName: task.exportName ?? "@deprecated",
          })),
        }
      : undefined,
  } satisfies GetDeploymentResponseBody);
}
