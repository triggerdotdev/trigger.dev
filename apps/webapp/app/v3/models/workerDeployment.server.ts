import type { Prettify } from "@trigger.dev/core";
import { BackgroundWorker } from "@trigger.dev/database";
import { CURRENT_DEPLOYMENT_LABEL, CURRENT_UNMANAGED_DEPLOYMENT_LABEL } from "~/consts";
import { Prisma, prisma } from "~/db.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";

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
  environmentId: string,
  label = CURRENT_DEPLOYMENT_LABEL
): Promise<WorkerDeploymentWithWorkerTasks | undefined> {
  const promotion = await prisma.workerDeploymentPromotion.findUnique({
    where: {
      environmentId_label: {
        environmentId,
        label,
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

export async function findCurrentUnmanagedWorkerDeployment(
  environmentId: string
): Promise<WorkerDeploymentWithWorkerTasks | undefined> {
  return await findCurrentWorkerDeployment(environmentId, CURRENT_UNMANAGED_DEPLOYMENT_LABEL);
}

export async function findCurrentWorkerFromEnvironment(
  environment: Pick<AuthenticatedEnvironment, "id" | "type">,
  label = CURRENT_DEPLOYMENT_LABEL
): Promise<BackgroundWorker | null> {
  if (environment.type === "DEVELOPMENT") {
    const latestDevWorker = await prisma.backgroundWorker.findFirst({
      where: {
        runtimeEnvironmentId: environment.id,
      },
      orderBy: {
        createdAt: "desc",
      },
    });
    return latestDevWorker;
  } else {
    const deployment = await findCurrentWorkerDeployment(environment.id, label);
    return deployment?.worker ?? null;
  }
}

export async function findCurrentUnmanagedWorkerFromEnvironment(
  environment: Pick<AuthenticatedEnvironment, "id" | "type">
): Promise<BackgroundWorker | null> {
  if (environment.type === "DEVELOPMENT") {
    return null;
  }

  return await findCurrentWorkerFromEnvironment(environment, CURRENT_UNMANAGED_DEPLOYMENT_LABEL);
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
