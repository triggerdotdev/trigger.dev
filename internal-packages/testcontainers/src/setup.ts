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
  prisma: PrismaClient,
  environment: AuthenticatedEnvironment,
  taskIdentifier: string | string[],
  machineConfig?: MachineConfig,
  retryOptions?: RetryOptions
) {
  const worker = await prisma.backgroundWorker.create({
    data: {
      friendlyId: generateFriendlyId("worker"),
      contentHash: "hash",
      projectId: environment.project.id,
      runtimeEnvironmentId: environment.id,
      version: "20241015.1",
      metadata: {},
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
    const task = await prisma.backgroundWorkerTask.create({
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
    const taskQueue = await prisma.taskQueue.create({
      data: {
        friendlyId: generateFriendlyId("queue"),
        name: queueName,
        concurrencyLimit: 10,
        runtimeEnvironmentId: worker.runtimeEnvironmentId,
        projectId: worker.projectId,
        type: "VIRTUAL",
      },
    });
  }

  if (environment.type !== "DEVELOPMENT") {
    const deployment = await prisma.workerDeployment.create({
      data: {
        friendlyId: generateFriendlyId("deployment"),
        contentHash: worker.contentHash,
        version: worker.version,
        shortCode: "short_code",
        imageReference: `trigger/${environment.project.externalRef}:${worker.version}.${environment.slug}`,
        status: "DEPLOYED",
        projectId: environment.project.id,
        environmentId: environment.id,
        workerId: worker.id,
      },
    });

    const promotion = await prisma.workerDeploymentPromotion.create({
      data: {
        label: CURRENT_DEPLOYMENT_LABEL,
        deploymentId: deployment.id,
        environmentId: environment.id,
      },
    });

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
