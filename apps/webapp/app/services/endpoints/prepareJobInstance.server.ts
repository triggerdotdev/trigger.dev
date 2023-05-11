import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { IngestSendEvent } from "~/routes/api/v3/events";
import semver from "semver";

export class PrepareJobInstanceService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(id: string) {
    const jobInstance = await this.#prismaClient.jobInstance.findUniqueOrThrow({
      where: {
        id,
      },
      include: {
        job: true,
        environment: {
          include: {
            organization: true,
            project: true,
          },
        },
      },
    });

    const service = new IngestSendEvent();

    await service.call(jobInstance.environment, {
      id: `${jobInstance.id}:prepare:${versionScopedToMinor(
        jobInstance.version
      )}`,
      name: "internal.trigger.prepare",
      source: "trigger.dev",
      payload: {
        jobId: jobInstance.job.slug,
        jobVersion: jobInstance.version,
      },
    });
  }
}

// Take a version string (e.g. 1.2.3) and return a version string that is scoped to the minor version (e.g. 1.2)
function versionScopedToMinor(version: string) {
  const parsed = semver.parse(version);

  if (!parsed) {
    throw new Error(`Invalid version: ${version}`);
  }

  return `${parsed.major}.${parsed.minor}`;
}
