// Bulk adds data to the database for testing
// Call it like this
// 1. pnpm run build:db:populate
// 2. pnpm run db:populate -- --projectRef=proj_liazlkfgmfcusswwgohl --taskIdentifier=child-task --runCount=100000
import { generateFriendlyId } from "~/v3/friendlyIdentifiers";
import { prisma } from "../app/db.server";

async function populate() {
  if (process.env.NODE_ENV !== "development") {
    return;
  }

  const projectRef = getArg("projectRef");
  if (!projectRef) {
    throw new Error("projectRef is required");
  }

  const project = await prisma.project.findUnique({
    include: {
      environments: true,
    },
    where: {
      externalRef: projectRef,
    },
  });
  if (!project) {
    throw new Error("Project not found");
  }

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
