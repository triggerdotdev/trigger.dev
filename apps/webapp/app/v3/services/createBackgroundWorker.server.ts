import { CreateBackgroundWorkerRequestBody } from "@trigger.dev/core";
import type { BackgroundWorker } from "@trigger.dev/database";
import { PrismaClient, prisma } from "~/db.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";

export class CreateBackgroundWorkerService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(
    projectRef: string,
    environment: AuthenticatedEnvironment,
    body: CreateBackgroundWorkerRequestBody
  ): Promise<BackgroundWorker> {
    const project = await this.#prismaClient.project.findUniqueOrThrow({
      where: {
        externalRef: projectRef,
        environments: {
          some: {
            id: environment.id,
          },
        },
      },
      include: {
        backgroundWorkers: {
          where: {
            runtimeEnvironmentId: environment.id,
          },
          orderBy: {
            version: "desc",
          },
          take: 1,
        },
      },
    });

    const nextVersion = calculateNextBuildVersion(project.backgroundWorkers[0]?.version);

    const backgroundWorker = await this.#prismaClient.backgroundWorker.create({
      data: {
        version: nextVersion,
        runtimeEnvironmentId: environment.id,
        projectId: project.id,
        metadata: body.metadata,
      },
    });

    for (const task of body.metadata.tasks) {
      await this.#prismaClient.backgroundWorkerTask.create({
        data: {
          projectId: project.id,
          runtimeEnvironmentId: environment.id,
          workerId: backgroundWorker.id,
          slug: task.id,
          filePath: task.filePath,
          exportName: task.exportName,
        },
      });
    }

    return backgroundWorker;
  }
}

// Calculate next build version based on the previous version
// Version formats are YYYYMMDD.1, YYYYMMDD.2, etc.
// If there is no previous version, start at Todays date and .1
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
