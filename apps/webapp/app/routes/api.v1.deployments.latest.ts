import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { WorkerInstanceGroupType } from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { authenticateApiKeyWithScope } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";

export async function loader({ request }: LoaderFunctionArgs) {
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

    const deployment = await prisma.workerDeployment.findFirst({
      where: {
        type: WorkerInstanceGroupType.UNMANAGED,
        environmentId: authenticatedEnv.id,
      },
      orderBy: {
        createdAt: "desc",
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
      errorData: deployment.errorData,
    });
  } catch (error) {
    if (error instanceof Response) throw error;
    logger.error("Failed to load latest deployment", { error });
    return json({ error: "Internal Server Error" }, { status: 500 });
  }
}
