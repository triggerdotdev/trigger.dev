import type {
  Endpoint,
  Organization,
  RuntimeEnvironment,
} from ".prisma/client";
import type { ApiJob } from "@trigger.dev/internal";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { ClientApi } from "../clientApi.server";

export class EndpointRegisteredService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(id: string) {
    const endpoint = await this.#prismaClient.endpoint.findUniqueOrThrow({
      where: {
        id,
      },
      include: {
        environment: {
          include: {
            organization: true,
          },
        },
      },
    });

    // Make a request to the endpoint to fetch a list of jobs
    const client = new ClientApi(endpoint.environment.apiKey, endpoint.url);

    const { jobs } = await client.getJobs();

    // Upsert the jobs into the database
    await Promise.all(
      jobs.map((job) =>
        this.#upsertJob(
          endpoint,
          endpoint.environment,
          endpoint.environment.organization,
          job
        )
      )
    );
  }

  async #upsertJob(
    endpoint: Endpoint,
    environment: RuntimeEnvironment,
    organization: Organization,
    apiJob: ApiJob
  ): Promise<void> {
    // Upsert the Job
    const job = await this.#prismaClient.job.upsert({
      where: {
        organizationId_slug: {
          organizationId: organization.id,
          slug: apiJob.id,
        },
      },
      create: {
        organization: {
          connect: {
            id: organization.id,
          },
        },
        slug: apiJob.id,
        title: apiJob.name,
      },
      update: {
        title: apiJob.name,
      },
    });

    // Upsert the JobInstance
    await this.#prismaClient.jobInstance.upsert({
      where: {
        jobId_version_endpointId: {
          jobId: job.id,
          version: apiJob.version,
          endpointId: endpoint.id,
        },
      },
      create: {
        job: {
          connect: {
            id: job.id,
          },
        },
        endpoint: {
          connect: {
            id: endpoint.id,
          },
        },
        environment: {
          connect: {
            id: environment.id,
          },
        },
        organization: {
          connect: {
            id: organization.id,
          },
        },
        version: apiJob.version,
        trigger: apiJob.trigger,
      },
      update: {
        trigger: apiJob.trigger,
      },
    });
  }
}
