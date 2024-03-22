import type { Prettify } from "@trigger.dev/core";
import { CURRENT_DEPLOYMENT_LABEL } from "~/consts";
import { prisma } from "~/db.server";

export type CurrentWorkerDeployment = Prettify<NonNullable<Awaited<ReturnType<typeof findCurrentWorkerDeployment>>>>;

export async function findCurrentWorkerDeployment(environmentId: string) {
  const promotion = await prisma.workerDeploymentPromotion.findUnique({
    where: {
      environmentId_label: {
        environmentId,
        label: CURRENT_DEPLOYMENT_LABEL,
      }
    },
    include: {
      deployment: {
        include: {
          worker: {
            include: {
              tasks: true,
            },
          },
        }
      }
    }
  });

  return promotion?.deployment;
}