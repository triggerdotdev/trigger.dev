import { type LoaderFunctionArgs, json } from "@remix-run/server-runtime";
import { type GetDeploymentResponseBody } from "@trigger.dev/core/v3";
import { z } from "zod";
import { prisma } from "~/db.server";
import { authenticateApiKeyWithScope } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";

const ParamsSchema = z.object({
  deploymentId: z.string(),
});

export async function loader({ request, params }: LoaderFunctionArgs) {
  const parsedParams = ParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    return json({ error: "Invalid params" }, { status: 400 });
  }

  try {
    // Next authenticate the request
    const authResult = await authenticateApiKeyWithScope(request, {
      action: "read",
      resource: { type: "deployments" },
    });

    if (!authResult.ok) {
      logger.info("Invalid or missing api key", { url: request.url });
      return json({ error: authResult.error }, { status: authResult.status });
    }

    const authenticationResult = authResult.authentication;

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
        integrationDeployments: true,
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
      commitSHA: deployment.commitSHA,
      externalId: deployment.externalId ?? undefined,
      externalBuildData:
        deployment.externalBuildData as GetDeploymentResponseBody["externalBuildData"],
      errorData: deployment.errorData as GetDeploymentResponseBody["errorData"],
      canceledReason: deployment.canceledReason,
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
      integrationDeployments:
        deployment.integrationDeployments.length > 0
          ? deployment.integrationDeployments.map((id) => ({
              id: id.id,
              integrationName: id.integrationName,
              integrationDeploymentId: id.integrationDeploymentId,
              commitSHA: id.commitSHA,
              createdAt: id.createdAt,
            }))
          : undefined,
    } satisfies GetDeploymentResponseBody);
  } catch (error) {
    if (error instanceof Response) throw error;
    logger.error("Failed to load deployment", { error });
    return json({ error: "Internal Server Error" }, { status: 500 });
  }
}
