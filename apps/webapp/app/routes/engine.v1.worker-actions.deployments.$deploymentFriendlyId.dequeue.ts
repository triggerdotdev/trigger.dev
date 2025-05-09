import { json, TypedResponse } from "@remix-run/server-runtime";
import { CURRENT_DEPLOYMENT_LABEL } from "@trigger.dev/core/v3/isomorphic";
import { WorkerApiDequeueResponseBody } from "@trigger.dev/core/v3/workers";
import { z } from "zod";
import { $replica, prisma } from "~/db.server";
import { createLoaderWorkerApiRoute } from "~/services/routeBuilders/apiBuilder.server";

export const loader = createLoaderWorkerApiRoute(
  {
    params: z.object({
      deploymentFriendlyId: z.string(),
    }),
    searchParams: z.object({
      maxRunCount: z.coerce.number().optional(),
    }),
  },
  async ({
    authenticatedWorker,
    params,
    searchParams,
  }): Promise<TypedResponse<WorkerApiDequeueResponseBody>> => {
    const deployment = await $replica.workerDeployment.findUnique({
      where: {
        friendlyId: params.deploymentFriendlyId,
      },
      include: {
        worker: true,
      },
    });

    if (!deployment) {
      throw new Error("Deployment not found");
    }

    if (!deployment.worker) {
      throw new Error("Worker not found");
    }

    const dequeuedMessages = (await isCurrentDeployment(deployment.id, deployment.environmentId))
      ? await authenticatedWorker.dequeueFromEnvironment(
          deployment.worker.id,
          deployment.environmentId
        )
      : await authenticatedWorker.dequeueFromVersion(
          deployment.worker.id,
          searchParams.maxRunCount
        );

    return json(dequeuedMessages);
  }
);

async function isCurrentDeployment(deploymentId: string, environmentId: string): Promise<boolean> {
  const promotion = await prisma.workerDeploymentPromotion.findUnique({
    where: {
      environmentId_label: {
        environmentId,
        label: CURRENT_DEPLOYMENT_LABEL,
      },
    },
  });

  if (!promotion) {
    return false;
  }

  return promotion.deploymentId === deploymentId;
}
