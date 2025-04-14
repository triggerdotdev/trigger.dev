import {
  CURRENT_DEPLOYMENT_LABEL,
  generateFriendlyId,
  sanitizeQueueName,
} from "@trigger.dev/core/v3/isomorphic";
import { MachineConfig, RetryOptions } from "@trigger.dev/core/v3/schemas";
import {
  BackgroundWorkerTask,
  Prisma,
  PrismaClient,
  RunEngineVersion,
  RuntimeEnvironmentType,
} from "@trigger.dev/database";
import { RunEngine } from "../index.js";

export type AuthenticatedEnvironment = Prisma.RuntimeEnvironmentGetPayload<{
  include: { project: true; organization: true; orgMember: true };
}>;

export async function setupAuthenticatedEnvironment(
  prisma: PrismaClient,
  type: RuntimeEnvironmentType,
  engine?: RunEngineVersion
) {
  // Your database setup logic here
  const org = await prisma.organization.create({
    data: {
      title: "Test Organization",
      slug: "test-organization",
    },
  });

  const project = await prisma.project.create({
    data: {
      name: "Test Project",
      slug: "test-project",
      externalRef: "proj_1234",
      organizationId: org.id,
      engine,
    },
  });

  const environment = await prisma.runtimeEnvironment.create({
    data: {
      type,
      slug: "slug",
      projectId: project.id,
      organizationId: org.id,
      apiKey: "api_key",
      pkApiKey: "pk_api_key",
      shortcode: "short_code",
      maximumConcurrencyLimit: 10,
    },
  });

  return await prisma.runtimeEnvironment.findUniqueOrThrow({
    where: {
      id: environment.id,
    },
    include: {
      project: true,
      organization: true,
      orgMember: true,
    },
  });
}

export async function setupBackgroundWorker(
  engine: RunEngine,
  environment: AuthenticatedEnvironment,
  taskIdentifier: string | string[],
  machineConfig?: MachineConfig,
  retryOptions?: RetryOptions,
  queueOptions?: {
    customQueues?: string[];
    releaseConcurrencyOnWaitpoint?: boolean;
    concurrencyLimit?: number | null;
  }
) {
  const latestWorkers = await engine.prisma.backgroundWorker.findMany({
    where: {
      runtimeEnvironmentId: environment.id,
    },
    orderBy: {
      createdAt: "desc",
    },
    take: 1,
  });

  const nextVersion = calculateNextBuildVersion(latestWorkers[0]?.version);

  const worker = await engine.prisma.backgroundWorker.create({
    data: {
      friendlyId: generateFriendlyId("worker"),
      contentHash: "hash",
      projectId: environment.project.id,
      runtimeEnvironmentId: environment.id,
      version: nextVersion,
      metadata: {},
      engine: "V2",
    },
  });

  const taskIdentifiers = Array.isArray(taskIdentifier) ? taskIdentifier : [taskIdentifier];

  const tasks: BackgroundWorkerTask[] = [];

  for (const identifier of taskIdentifiers) {
    const retryConfig: RetryOptions = retryOptions ?? {
      maxAttempts: 3,
      factor: 1,
      minTimeoutInMs: 100,
      maxTimeoutInMs: 100,
      randomize: false,
    };
    const task = await engine.prisma.backgroundWorkerTask.create({
      data: {
        friendlyId: generateFriendlyId("task"),
        slug: identifier,
        filePath: `/trigger/${identifier}.ts`,
        exportName: identifier,
        workerId: worker.id,
        runtimeEnvironmentId: environment.id,
        projectId: environment.project.id,
        machineConfig,
        retryConfig,
      },
    });

    tasks.push(task);

    const queueName = sanitizeQueueName(`task/${identifier}`);
    const taskQueue = await engine.prisma.taskQueue.upsert({
      where: {
        runtimeEnvironmentId_name: {
          name: queueName,
          runtimeEnvironmentId: worker.runtimeEnvironmentId,
        },
      },
      create: {
        friendlyId: generateFriendlyId("queue"),
        name: queueName,
        concurrencyLimit:
          typeof queueOptions?.concurrencyLimit === "undefined"
            ? 10
            : queueOptions.concurrencyLimit,
        runtimeEnvironmentId: worker.runtimeEnvironmentId,
        projectId: worker.projectId,
        type: "VIRTUAL",
        workers: {
          connect: {
            id: worker.id,
          },
        },
        releaseConcurrencyOnWaitpoint:
          typeof queueOptions?.releaseConcurrencyOnWaitpoint === "boolean"
            ? queueOptions.releaseConcurrencyOnWaitpoint
            : undefined,
      },
      update: {
        concurrencyLimit:
          typeof queueOptions?.concurrencyLimit === "undefined"
            ? 10
            : queueOptions.concurrencyLimit,
        workers: {
          connect: {
            id: worker.id,
          },
        },
      },
    });

    if (typeof taskQueue.concurrencyLimit === "number") {
      await engine.runQueue.updateQueueConcurrencyLimits(
        environment,
        queueName,
        taskQueue.concurrencyLimit
      );
    } else {
      await engine.runQueue.removeQueueConcurrencyLimits(environment, queueName);
    }
  }

  for (const queueName of queueOptions?.customQueues ?? []) {
    const taskQueue = await engine.prisma.taskQueue.upsert({
      where: {
        runtimeEnvironmentId_name: {
          name: queueName,
          runtimeEnvironmentId: worker.runtimeEnvironmentId,
        },
      },
      create: {
        friendlyId: generateFriendlyId("queue"),
        name: queueName,
        concurrencyLimit:
          typeof queueOptions?.concurrencyLimit === "undefined"
            ? 10
            : queueOptions.concurrencyLimit,
        runtimeEnvironmentId: worker.runtimeEnvironmentId,
        projectId: worker.projectId,
        type: "VIRTUAL",
        workers: {
          connect: {
            id: worker.id,
          },
        },
        releaseConcurrencyOnWaitpoint:
          typeof queueOptions?.releaseConcurrencyOnWaitpoint === "boolean"
            ? queueOptions.releaseConcurrencyOnWaitpoint
            : undefined,
      },
      update: {
        concurrencyLimit:
          typeof queueOptions?.concurrencyLimit === "undefined"
            ? 10
            : queueOptions.concurrencyLimit,
        workers: {
          connect: {
            id: worker.id,
          },
        },
      },
    });
  }

  if (environment.type !== "DEVELOPMENT") {
    const deployment = await engine.prisma.workerDeployment.create({
      data: {
        friendlyId: generateFriendlyId("deployment"),
        contentHash: worker.contentHash,
        version: worker.version,
        shortCode: `short_code_${worker.version}`,
        imageReference: `trigger/${environment.project.externalRef}:${worker.version}.${environment.slug}`,
        status: "DEPLOYED",
        projectId: environment.project.id,
        environmentId: environment.id,
        workerId: worker.id,
        type: "MANAGED",
      },
    });

    const promotion = await engine.prisma.workerDeploymentPromotion.upsert({
      where: {
        environmentId_label: {
          environmentId: deployment.environmentId,
          label: CURRENT_DEPLOYMENT_LABEL,
        },
      },
      create: {
        deploymentId: deployment.id,
        environmentId: deployment.environmentId,
        label: CURRENT_DEPLOYMENT_LABEL,
      },
      update: {
        deploymentId: deployment.id,
      },
    });

    //now we deploy the background worker
    await engine.scheduleEnqueueRunsForBackgroundWorker(worker.id);

    return {
      worker,
      tasks,
      deployment,
      promotion,
    };
  }

  return {
    worker,
    tasks,
  };
}

function calculateNextBuildVersion(latestVersion?: string | null): string {
  const today = new Date();
  const year = today.getFullYear();
  const month = today.getMonth() + 1;
  const day = today.getDate();
  const todayFormatted = `${year}${month < 10 ? "0" : ""}${month}${day < 10 ? "0" : ""}${day}`;

  if (!latestVersion) {
    return `${todayFormatted}.1`;
  }

  const [date, buildNumber] = latestVersion.split(".");

  if (date === todayFormatted) {
    const nextBuildNumber = parseInt(buildNumber, 10) + 1;
    return `${date}.${nextBuildNumber}`;
  }

  return `${todayFormatted}.1`;
}
