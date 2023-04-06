import type {
  Endpoint,
  Organization,
  RuntimeEnvironment,
  Job,
  JobInstance,
  JobConnection,
} from ".prisma/client";
import type { ApiJob, ConnectionMetadata } from "@trigger.dev/internal";
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
      include: {
        connections: true,
      },
    });

    // Upsert the JobInstance
    const jobInstance = await this.#prismaClient.jobInstance.upsert({
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
      include: {
        connections: true,
      },
    });

    if (apiJob.trigger.connection) {
      await this.#upsertJobConnection(
        job,
        jobInstance,
        "__trigger",
        apiJob.trigger.connection
      );
    }

    // Upsert the connections
    for (const connection of apiJob.connections) {
      await this.#upsertJobConnection(
        job,
        jobInstance,
        connection.key,
        connection.metadata
      );
    }
  }

  async #upsertJobConnection(
    job: Job & { connections: JobConnection[] },
    jobInstance: JobInstance & { connections: JobConnection[] },
    key: string,
    metadata: ConnectionMetadata
  ): Promise<JobConnection> {
    // Find existing connection in the job instance
    const existingInstanceConnection = jobInstance.connections.find(
      (connection) => connection.key === key
    );

    if (existingInstanceConnection) {
      return existingInstanceConnection;
    }

    // Find existing connection in the job
    const existingJobConnection = job.connections.find(
      (connection) => connection.key === key
    );

    if (existingJobConnection) {
      return this.#prismaClient.jobConnection.create({
        data: {
          jobInstance: {
            connect: {
              id: jobInstance.id,
            },
          },
          job: {
            connect: {
              id: job.id,
            },
          },
          key,
          connectionMetadata: existingJobConnection.connectionMetadata ?? {},
          apiConnection: existingJobConnection.apiConnectionId
            ? {
                connect: {
                  id: existingJobConnection.apiConnectionId,
                },
              }
            : undefined,
        },
      });
    }

    // Find existing APIConnection in the org
    const existingApiConnection =
      await this.#prismaClient.aPIConnection.findFirst({
        where: {
          apiIdentifier: metadata.id,
          organizationId: job.organizationId,
        },
      });

    return this.#prismaClient.jobConnection.create({
      data: {
        jobInstance: {
          connect: {
            id: jobInstance.id,
          },
        },
        job: {
          connect: {
            id: job.id,
          },
        },
        key,
        connectionMetadata: metadata,
        apiConnection: existingApiConnection
          ? {
              connect: {
                id: existingApiConnection.id,
              },
            }
          : undefined,
      },
    });
  }
}
