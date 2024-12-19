// Bulk adds data to the database for testing
// Call it like this
// 1. pnpm run build:db:populate
// 2. pnpm run db:populate -- --projectRef=proj_liazlkfgmfcusswwgohl --taskIdentifier=child-task --runCount=100000
import { generateFriendlyId } from "~/v3/friendlyIdentifiers";
import { prisma } from "../app/db.server";
import { createHash } from "crypto";
import {
  BackgroundWorker,
  BackgroundWorkerTask,
  RuntimeEnvironmentType,
  WorkerInstanceGroupType,
} from "@trigger.dev/database";
import { nanoid } from "nanoid";

async function populate() {
  if (process.env.NODE_ENV !== "development") {
    return;
  }

  const project = await getProject();

  await generateRuns(project);
  await createWorkerGroup(project);
  const { worker, tasks } = await createBackgroundWorker(project, getEnvTypeFromArg());
  await createWorkerDeployment(project, worker, getEnvTypeFromArg());
}

function getEnvironment(
  project: ProjectWithEnvironment,
  envType: RuntimeEnvironmentType = "PRODUCTION"
) {
  const env = project.environments.find((e) => e.type === envType);

  if (!env) {
    throw new Error(`No environment of type "${envType}" found for project ${project.id}`);
  }

  return env;
}

async function createWorkerDeployment(
  project: ProjectWithEnvironment,
  worker: BackgroundWorker,
  envType: RuntimeEnvironmentType = "PRODUCTION"
) {
  const env = getEnvironment(project, envType);
  const deploymentId = `cm3c821sk00032v6is7ufqy3d-${env.slug}`;

  if (env.type === "DEVELOPMENT") {
    console.warn("Skipping deployment creation for development environment");
    return;
  }

  let deployment = await prisma.workerDeployment.findUnique({
    where: {
      id: deploymentId,
    },
  });

  if (deployment) {
    console.log(`Deployment "${deploymentId}" already exists`);
    return deployment;
  }

  const firstOrgMember = project.organization.members[0];

  deployment = await prisma.workerDeployment.create({
    data: {
      id: deploymentId,
      friendlyId: generateFriendlyId("deployment"),
      contentHash: worker.contentHash,
      version: worker.version,
      shortCode: nanoid(8),
      imageReference: `trigger/${project.externalRef}:${worker.version}.${env.slug}`,
      status: "DEPLOYING",
      projectId: project.id,
      environmentId: env.id,
      workerId: worker.id,
      triggeredById: firstOrgMember.userId,
    },
  });

  console.log(`Created deployment "${deploymentId}"`);

  return deployment;
}

async function createBackgroundWorker(
  project: ProjectWithEnvironment,
  envType: RuntimeEnvironmentType = "PRODUCTION"
) {
  const env = getEnvironment(project, envType);
  const taskIdentifier = "seed-task";
  const backgroundWorkerId = `cm3c8fmiv00042v6imoqwxst1-${env.slug}`;

  let worker = await prisma.backgroundWorker.findUnique({
    where: {
      id: backgroundWorkerId,
    },
    include: {
      tasks: true,
    },
  });

  if (worker) {
    console.log(`Worker "${backgroundWorkerId}" already exists`);

    return {
      worker,
      tasks: worker.tasks,
    };
  }

  worker = await prisma.backgroundWorker.create({
    data: {
      id: backgroundWorkerId,
      friendlyId: generateFriendlyId("worker"),
      contentHash: "hash",
      projectId: project.id,
      runtimeEnvironmentId: env.id,
      version: "20241111.1",
      metadata: {},
    },
    include: {
      tasks: true,
    },
  });

  console.log(`Created worker "${backgroundWorkerId}"`);

  const taskIdentifiers = Array.isArray(taskIdentifier) ? taskIdentifier : [taskIdentifier];

  const tasks: BackgroundWorkerTask[] = [];

  for (const identifier of taskIdentifiers) {
    const task = await prisma.backgroundWorkerTask.create({
      data: {
        friendlyId: generateFriendlyId("task"),
        slug: identifier,
        filePath: `/trigger/${identifier}.ts`,
        exportName: identifier,
        workerId: worker.id,
        runtimeEnvironmentId: env.id,
        projectId: project.id,
      },
    });

    tasks.push(task);
  }

  return {
    worker,
    tasks,
  };
}

async function createWorkerGroup(project: ProjectWithEnvironment) {
  const workerGroupName = "seed-unmanaged";
  const rawToken = "tr_wgt_15480aa1712cae4b8db8c7a49707d69d";

  const existingWorkerGroup = await prisma.workerInstanceGroup.findFirst({
    where: {
      projectId: project.id,
      name: workerGroupName,
    },
  });

  if (existingWorkerGroup) {
    console.log(`Worker group "${workerGroupName}" already exists`);

    await setAsDefaultWorkerGroup(project, existingWorkerGroup.id);

    return existingWorkerGroup;
  }

  const token = await prisma.workerGroupToken.create({
    data: {
      tokenHash: createHash("sha256").update(rawToken).digest("hex"),
    },
  });

  const workerGroup = await prisma.workerInstanceGroup.create({
    data: {
      projectId: project.id,
      organizationId: project.organizationId,
      type: WorkerInstanceGroupType.UNMANAGED,
      masterQueue: `${project.id}-${workerGroupName}`,
      tokenId: token.id,
      description: "Seeded worker group",
      name: workerGroupName,
    },
  });

  await setAsDefaultWorkerGroup(project, workerGroup.id);

  return workerGroup;
}

async function setAsDefaultWorkerGroup(project: ProjectWithEnvironment, workerGroupId: string) {
  // Set as default worker group
  await prisma.project.update({
    where: {
      id: project.id,
    },
    data: {
      defaultWorkerGroupId: workerGroupId,
    },
  });
}

async function getProject() {
  const projectRef = getArg("projectRef");
  if (!projectRef) {
    throw new Error("projectRef is required");
  }

  const project = await prisma.project.findUnique({
    include: {
      environments: true,
      organization: {
        include: {
          members: true,
        },
      },
    },
    where: {
      externalRef: projectRef,
    },
  });

  if (!project) {
    throw new Error("Project not found");
  }

  return project;
}

type ProjectWithEnvironment = Awaited<ReturnType<typeof getProject>>;

async function generateRuns(project: ProjectWithEnvironment) {
  const taskIdentifier = getArg("taskIdentifier");
  if (!taskIdentifier) {
    throw new Error("taskIdentifier is required");
  }

  const runCount = parseInt(getArg("runCount") || "100");

  const task = await prisma.backgroundWorkerTask.findFirst({
    where: {
      projectId: project.id,
      slug: taskIdentifier,
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  if (!task) {
    throw new Error("Task not found");
  }

  const runs = await prisma.taskRun.createMany({
    data: Array(runCount)
      .fill(0)
      .map((_, index) => {
        const friendlyId = generateFriendlyId("run");

        return {
          status: "CANCELED",
          completedAt: new Date(),
          number: index + 1,
          friendlyId,
          runtimeEnvironmentId: project.environments[randomIndex(project.environments)].id,
          projectId: project.id,
          taskIdentifier,
          payload: JSON.stringify({ foo: "bar" }),
          traceId: "traceId",
          spanId: "spanId",
          queue: "task/${taskIdentifier}",
        };
      }),
    skipDuplicates: true,
  });

  console.log(`Added ${runs.count} runs`);
}

function getEnvTypeFromArg(): RuntimeEnvironmentType {
  const env = getArg("env");

  if (!env) {
    return RuntimeEnvironmentType.PRODUCTION;
  }

  switch (env) {
    case "dev":
      return RuntimeEnvironmentType.DEVELOPMENT;
    case "prod":
      return RuntimeEnvironmentType.PRODUCTION;
    case "stg":
      return RuntimeEnvironmentType.STAGING;
    default:
      throw new Error(`Invalid environment: ${env}`);
  }
}

function getArg(name: string) {
  const args = process.argv.slice(2);

  let value = "";

  args.forEach((val) => {
    if (val.startsWith(`--${name}=`)) {
      value = val.split("=")[1];
    }
  });

  return !value ? undefined : value;
}

function randomIndex<T>(array: T[]) {
  return Math.floor(Math.random() * array.length);
}

populate()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
