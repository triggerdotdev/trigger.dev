import type { CreateRunBody } from "@trigger.dev/internal";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { AuthenticatedEnvironment } from "../apiAuth.server";
import { CreateRunService } from "./createRun.server";

export class PostRunService {
  #prismaClient: PrismaClient;
  #createExecutionService = new CreateRunService();

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(
    environment: AuthenticatedEnvironment,
    data: CreateRunBody
  ) {
    const endpoint = await this.#prismaClient.endpoint.findUniqueOrThrow({
      where: {
        environmentId_slug: {
          environmentId: environment.id,
          slug: data.client,
        },
      },
    });

    const job = await this.#prismaClient.job.findUniqueOrThrow({
      where: {
        projectId_slug: {
          projectId: environment.projectId,
          slug: data.job.id,
        },
      },
    });

    const jobInstance = await this.#prismaClient.jobInstance.findUniqueOrThrow({
      where: {
        jobId_version_endpointId: {
          jobId: job.id,
          version: data.job.version,
          endpointId: endpoint.id,
        },
      },
    });

    return this.#createExecutionService.call({
      environment,
      job,
      jobInstance,
      eventId: data.event.id,
    });
  }
}
