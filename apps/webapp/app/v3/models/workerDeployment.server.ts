import type { Prettify } from "@trigger.dev/core";
import { BackgroundWorker, WorkerDeployment } from "@trigger.dev/database";
import {
  CURRENT_DEPLOYMENT_LABEL,
  CURRENT_UNMANAGED_DEPLOYMENT_LABEL,
} from "@trigger.dev/core/v3/isomorphic";
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
        engine: true;
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
            queueConfig: true;
          };
        };
      };
    };
  };
}>;

export async function findCurrentWorkerDeployment(
  environmentId: string,
  label = CURRENT_DEPLOYMENT_LABEL
): Promise<WorkerDeploymentWithWorkerTasks | undefined> {
  const promotion = await prisma.workerDeploymentPromotion.findFirst({
    where: {
      environmentId,
      label,
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
              engine: true,
            },
          },
        },
      },
    },
  });

  return promotion?.deployment;
}

export async function findCurrentWorkerDeploymentWithoutTasks(
  environmentId: string,
  label = CURRENT_DEPLOYMENT_LABEL
): Promise<WorkerDeployment | undefined> {
  const promotion = await prisma.workerDeploymentPromotion.findUnique({
    where: {
      environmentId_label: {
        environmentId,
        label,
      },
    },
    include: {
      deployment: true,
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
): Promise<Pick<
  BackgroundWorker,
  "id" | "friendlyId" | "version" | "sdkVersion" | "cliVersion" | "supportsLazyAttempts" | "engine"
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
    const deployment = await findCurrentWorkerDeployment(environment.id, label);
    return deployment?.worker ?? null;
  }
}

export async function findCurrentUnmanagedWorkerFromEnvironment(
  environment: Pick<AuthenticatedEnvironment, "id" | "type">
): Promise<Pick<
  BackgroundWorker,
  "id" | "friendlyId" | "version" | "sdkVersion" | "cliVersion" | "supportsLazyAttempts"
> | null> {
  if (environment.type === "DEVELOPMENT") {
    return null;
  }

  return await findCurrentWorkerFromEnvironment(environment, CURRENT_UNMANAGED_DEPLOYMENT_LABEL);
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
