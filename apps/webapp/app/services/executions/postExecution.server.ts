import type { Organization, RuntimeEnvironment } from ".prisma/client";
import type { CreateExecutionBody } from "@trigger.dev/internal";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { CreateExecutionService } from "./createExecution.server";

export class PostExecutionService {
  #prismaClient: PrismaClient;
  #createExecutionService = new CreateExecutionService();

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(
    environment: RuntimeEnvironment,
    organization: Organization,
    data: CreateExecutionBody
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
        organizationId_slug: {
          organizationId: organization.id,
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
      organization,
      job,
      jobInstance,
      eventId: data.event.id,
    });
  }
}
