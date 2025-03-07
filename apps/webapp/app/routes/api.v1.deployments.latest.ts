import { LoaderFunctionArgs, json } from "@remix-run/server-runtime";
import { WorkerInstanceGroupType } from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";

export async function loader({ request }: LoaderFunctionArgs) {
  // Next authenticate the request
  const authenticationResult = await authenticateApiRequest(request);

  if (!authenticationResult) {
    logger.info("Invalid or missing api key", { url: request.url });
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

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
}
