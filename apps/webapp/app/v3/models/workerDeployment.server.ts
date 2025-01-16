import type { Prettify } from "@trigger.dev/core";
import { BackgroundWorker } from "@trigger.dev/database";
import { CURRENT_DEPLOYMENT_LABEL } from "~/consts";
import { Prisma, prisma } from "~/db.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";

export type CurrentWorkerDeployment = Prettify<
  NonNullable<Awaited<ReturnType<typeof findCurrentWorkerDeployment>>>
>;

export type BackgroundWorkerTaskSlim = Prisma.BackgroundWorkerTaskGetPayload<{
  select: {
    id: true;
    friendlyId: true;
    slug: true;
    filePath: true;
    exportName: true;
    triggerSource: true;
    machineConfig: true;
    maxDurationInSeconds: true;
  };
}>;

type WorkerDeploymentWithWorkerTasks = Prisma.WorkerDeploymentGetPayload<{
  select: {
    id: true;
    imageReference: true;
    version: true;
    worker: {
      select: {
        id: true;
        friendlyId: true;
        version: true;
        sdkVersion: true;
        cliVersion: true;
        supportsLazyAttempts: true;
        tasks: {
          select: {
            id: true;
            friendlyId: true;
            slug: true;
            filePath: true;
            exportName: true;
            triggerSource: true;
            machineConfig: true;
            maxDurationInSeconds: true;
          };
        };
      };
    };
  };
}>;

export async function findCurrentWorkerDeployment(
  environmentId: string
): Promise<WorkerDeploymentWithWorkerTasks | undefined> {
  const promotion = await prisma.workerDeploymentPromotion.findFirst({
    where: {
      environmentId,
      label: CURRENT_DEPLOYMENT_LABEL,
    },
    select: {
      deployment: {
        select: {
          id: true,
          imageReference: true,
          version: true,
          worker: {
            select: {
              id: true,
              friendlyId: true,
              version: true,
              sdkVersion: true,
              cliVersion: true,
              supportsLazyAttempts: true,
              tasks: true,
            },
          },
        },
      },
    },
  });

  return promotion?.deployment;
}

export async function findCurrentWorkerFromEnvironment(
  environment: Pick<AuthenticatedEnvironment, "id" | "type">
): Promise<Pick<
  BackgroundWorker,
  "id" | "friendlyId" | "version" | "sdkVersion" | "cliVersion" | "supportsLazyAttempts"
> | null> {
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
    const deployment = await findCurrentWorkerDeployment(environment.id);
    return deployment?.worker ?? null;
  }
}

export async function getWorkerDeploymentFromWorker(
  workerId: string
): Promise<WorkerDeploymentWithWorkerTasks | undefined> {
  const worker = await prisma.backgroundWorker.findFirst({
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
  const workerTask = await prisma.backgroundWorkerTask.findFirst({
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
