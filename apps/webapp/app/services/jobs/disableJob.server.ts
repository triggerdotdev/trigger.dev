import type { JobVersion } from "@trigger.dev/database";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { ExtendedEndpoint, findEndpoint } from "~/models/endpoint.server";
import type { AuthenticatedEnvironment } from "../apiAuth.server";
import { DisableScheduleSourceService } from "../schedules/disableScheduleSource.server";

export type DisableJobServiceOptions = {
  slug: string;
  version: string;
};

export class DisableJobService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(
    endpointIdOrEndpoint: string | ExtendedEndpoint,
    options: DisableJobServiceOptions
  ) {
    const endpoint =
      typeof endpointIdOrEndpoint === "string"
        ? await findEndpoint(endpointIdOrEndpoint)
        : endpointIdOrEndpoint;

    return this.#disableJob(endpoint.environment, options);
  }

  async #disableJob(
    environment: AuthenticatedEnvironment,
    options: DisableJobServiceOptions
  ): Promise<JobVersion | undefined> {
    // Find the job
    const job = await this.#prismaClient.job.findUnique({
      where: {
        projectId_slug: {
          projectId: environment.projectId,
          slug: options.slug,
        },
      },
    });

    if (!job) {
      return;
    }

    const jobVersion = await this.#prismaClient.jobVersion.findUnique({
      where: {
        jobId_version_environmentId: {
          jobId: job.id,
          version: options.version,
          environmentId: environment.id,
        },
      },
    });

    if (!jobVersion) {
      return;
    }

    if (jobVersion.status === "DISABLED") {
      return;
    }

    // Upsert the JobVersion
    const updatedJobVersion = await this.#prismaClient.jobVersion.update({
      where: {
        id: jobVersion.id,
      },
      data: {
        status: "DISABLED",
      },
    });

    await this.#disableEventDispatcher(updatedJobVersion);

    return updatedJobVersion;
  }

  async #disableEventDispatcher(jobVersion: JobVersion) {
    const eventDispatcher = await this.#prismaClient.eventDispatcher.update({
      where: {
        dispatchableId_environmentId: {
          dispatchableId: jobVersion.jobId,
          environmentId: jobVersion.environmentId,
        },
      },
      data: {
        enabled: false,
      },
    });

    const service = new DisableScheduleSourceService();

    await service.call({
      key: jobVersion.jobId,
      dispatcher: eventDispatcher,
    });
  }
}
