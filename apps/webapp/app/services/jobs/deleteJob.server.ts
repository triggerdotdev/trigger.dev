import type { Job } from "@trigger.dev/database";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { telemetry } from "../telemetry.server";

export class DeleteJobService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(job: Job) {
    // Make sure that all the latest versions are disabled
    const latestVersions = await this.#prismaClient.jobAlias.findMany({
      where: {
        jobId: job.id,
        name: "latest",
      },
      include: {
        version: true,
      },
    });

    const allDisabled = latestVersions.every((alias) => alias.version.status === "DISABLED");

    if (!allDisabled) {
      throw new Error("All latest versions must be disabled before deleting a job");
    }

    // Okay now we need to delete a job by setting the deletedAt field and enqueuing a job to cleanup the job
    await this.#prismaClient.job.update({
      where: {
        id: job.id,
      },
      data: {
        deletedAt: new Date(),
      },
    });

    telemetry.project.deletedJob({
      job,
    });
  }
}
