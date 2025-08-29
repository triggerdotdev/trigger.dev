import type { Prettify } from "@trigger.dev/core";
import {
  BackgroundWorker,
  PrismaClientOrTransaction,
  RunEngineVersion,
  WorkerDeploymentType,
} from "@trigger.dev/database";
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
            queueId: true;
          };
        };
      };
    };
  };
}>;

/**
 * Finds the current worker deployment for a given environment.
 *
 * @param environmentId - The ID of the environment to find the current worker deployment for.
 * @param label - The label of the current worker deployment to find.
 * @param type - The type of worker deployment to find. If the current deployment is NOT of this type,
 *   we will return the latest deployment of the given type.
 */
export async function findCurrentWorkerDeployment({
  environmentId,
  label = CURRENT_DEPLOYMENT_LABEL,
  type,
  prismaClient,
}: {
  environmentId: string;
  label?: string;
  type?: WorkerDeploymentType;
  prismaClient?: PrismaClientOrTransaction;
}): Promise<WorkerDeploymentWithWorkerTasks | undefined> {
  const $prisma = prismaClient ?? prisma;

  const promotion = await $prisma.workerDeploymentPromotion.findFirst({
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
          type: true,
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

  if (!promotion) {
    return undefined;
  }

  if (!type) {
    return promotion.deployment;
  }

  if (promotion.deployment.type === type) {
    return promotion.deployment;
  }

  // We need to get the latest deployment of the given type
  const latestDeployment = await prisma.workerDeployment.findFirst({
    where: {
      environmentId,
      type,
    },
    orderBy: {
      id: "desc",
    },
    select: {
      id: true,
      imageReference: true,
      version: true,
      type: true,
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
  });

  if (!latestDeployment) {
    return undefined;
  }

  return latestDeployment;
}

export async function getCurrentWorkerDeploymentEngineVersion(
  environmentId: string,
  label = CURRENT_DEPLOYMENT_LABEL
): Promise<RunEngineVersion | undefined> {
  const promotion = await prisma.workerDeploymentPromotion.findFirst({
    where: {
      environmentId,
      label,
    },
    select: {
      deployment: {
        select: {
          type: true,
        },
      },
    },
  });

  if (typeof promotion?.deployment.type === "string") {
    return promotion.deployment.type === "V1" ? "V1" : "V2";
  }

  return undefined;
}

export async function findCurrentUnmanagedWorkerDeployment(
  environmentId: string
): Promise<WorkerDeploymentWithWorkerTasks | undefined> {
  return await findCurrentWorkerDeployment({
    environmentId,
    label: CURRENT_UNMANAGED_DEPLOYMENT_LABEL,
    type: "UNMANAGED",
  });
}

export async function findCurrentWorkerFromEnvironment(
  environment: Pick<AuthenticatedEnvironment, "id" | "type">,
  prismaClient: PrismaClientOrTransaction = prisma,
  label = CURRENT_DEPLOYMENT_LABEL
): Promise<Pick<
  BackgroundWorker,
  "id" | "friendlyId" | "version" | "sdkVersion" | "cliVersion" | "supportsLazyAttempts" | "engine"
> | null> {
  if (environment.type === "DEVELOPMENT") {
    const latestDevWorker = await prismaClient.backgroundWorker.findFirst({
      where: {
        runtimeEnvironmentId: environment.id,
      },
      orderBy: {
        createdAt: "desc",
      },
    });
    return latestDevWorker;
  } else {
    const deployment = await findCurrentWorkerDeployment({
      environmentId: environment.id,
      label,
      prismaClient,
    });
    return deployment?.worker ?? null;
  }
}

export async function findCurrentUnmanagedWorkerFromEnvironment(
  environment: Pick<AuthenticatedEnvironment, "id" | "type">,
  prismaClient: PrismaClientOrTransaction = prisma
): Promise<Pick<
  BackgroundWorker,
  "id" | "friendlyId" | "version" | "sdkVersion" | "cliVersion" | "supportsLazyAttempts"
> | null> {
  if (environment.type === "DEVELOPMENT") {
    return null;
  }

  return await findCurrentWorkerFromEnvironment(
    environment,
    prismaClient,
    CURRENT_UNMANAGED_DEPLOYMENT_LABEL
  );
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
