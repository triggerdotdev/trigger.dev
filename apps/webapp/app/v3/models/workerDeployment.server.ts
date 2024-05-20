import type { Prettify } from "@trigger.dev/core";
import { CURRENT_DEPLOYMENT_LABEL } from "~/consts";
import { Prisma, prisma } from "~/db.server";

export type CurrentWorkerDeployment = Prettify<
  NonNullable<Awaited<ReturnType<typeof findCurrentWorkerDeployment>>>
>;

type WorkerDeploymentWithWorkerTasks = Prisma.WorkerDeploymentGetPayload<{
  include: {
    worker: {
      include: {
        tasks: true;
      };
    };
  };
}>;

export async function findCurrentWorkerDeployment(
  environmentId: string
): Promise<WorkerDeploymentWithWorkerTasks | undefined> {
  const promotion = await prisma.workerDeploymentPromotion.findUnique({
    where: {
      environmentId_label: {
        environmentId,
        label: CURRENT_DEPLOYMENT_LABEL,
      },
    },
    include: {
      deployment: {
        include: {
          worker: {
            include: {
              tasks: true,
            },
          },
        },
      },
    },
  });

  return promotion?.deployment;
}

export async function getWorkerDeploymentFromWorker(
  workerId: string
): Promise<WorkerDeploymentWithWorkerTasks | undefined> {
  const worker = await prisma.backgroundWorker.findUnique({
    where: {
      id: workerId,
    },
    include: {
      deployment: true,
      tasks: true,
    },
  });

  if (!worker?.deployment) {
    return;
  }

  const { deployment, ...workerWithoutDeployment } = worker;

  return {
    ...deployment,
    worker: workerWithoutDeployment,
  };
}

export async function getWorkerDeploymentFromWorkerTask(
  workerTaskId: string
): Promise<WorkerDeploymentWithWorkerTasks | undefined> {
  const workerTask = await prisma.backgroundWorkerTask.findUnique({
    where: {
      id: workerTaskId,
    },
    include: {
      worker: {
        include: {
          deployment: true,
          tasks: true,
        },
      },
    },
  });

  if (!workerTask?.worker.deployment) {
    return;
  }

  const { deployment, ...workerWithoutDeployment } = workerTask.worker;

  return {
    ...deployment,
    worker: workerWithoutDeployment,
  };
}
