import type {
  Endpoint,
  Job,
  JobConnection,
  JobInstance,
  ApiConnection,
} from ".prisma/client";
import type { ApiJob, ConnectionMetadata } from "@trigger.dev/internal";
import semver from "semver";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import type { AuthenticatedEnvironment } from "../apiAuth.server";
import { ClientApi } from "../clientApi.server";
import { allConnectionsReady } from "../jobs/utils.server";
import { logger } from "../logger";
import { workerQueue } from "../worker.server";

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
            project: true,
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
      jobs.map((job) => this.#upsertJob(endpoint, endpoint.environment, job))
    );

    await workerQueue.enqueue("prepareForJobExecution", {
      id: endpoint.id,
    });
  }

  async #upsertJob(
    endpoint: Endpoint,
    environment: AuthenticatedEnvironment,
    apiJob: ApiJob
  ): Promise<void> {
    logger.debug("Upserting job", {
      endpoint,
      organizationId: environment.organizationId,
      apiJob,
    });

    // Upsert the Job
    const job = await this.#prismaClient.job.upsert({
      where: {
        projectId_slug: {
          projectId: environment.projectId,
          slug: apiJob.id,
        },
      },
      create: {
        organization: {
          connect: {
            id: environment.organizationId,
          },
        },
        project: {
          connect: {
            id: environment.projectId,
          },
        },
        slug: apiJob.id,
        title: apiJob.name,
      },
      update: {
        title: apiJob.name,
      },
      include: {
        connections: {
          include: {
            apiConnection: true,
          },
        },
        instances: {
          where: {
            endpointId: endpoint.id,
          },
          orderBy: { version: "desc" },
          take: 1,
        },
      },
    });

    const latestInstance = job.instances[0];

    let ready = false;

    if (typeof latestInstance === "undefined") {
      ready = !apiJob.supportsPreparation;
    } else {
      if (latestInstance.ready) {
        // Only carry over the ready state if the it's a PATCH or EQUAL update
        ready = ["PATCH", "EQUAL"].includes(
          getSemverUpdate(latestInstance.version, apiJob.version)
        );
      }
    }

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
            id: environment.organizationId,
          },
        },
        project: {
          connect: {
            id: environment.projectId,
          },
        },
        version: apiJob.version,
        trigger: apiJob.trigger,
        ready,
      },
      update: {
        trigger: apiJob.trigger,
      },
      include: {
        connections: {
          include: {
            apiConnection: true,
          },
        },
      },
    });

    const upsertedConnections: Array<JobConnection> = [];

    if (apiJob.trigger.connection) {
      upsertedConnections.push(
        await this.#upsertJobConnection(
          job,
          jobInstance,
          "__trigger",
          apiJob.trigger.connection.metadata,
          apiJob.trigger.connection.usesLocalAuth,
          apiJob.trigger.connection.id
        )
      );
    }

    // Upsert the connections
    for (const connection of apiJob.connections) {
      upsertedConnections.push(
        await this.#upsertJobConnection(
          job,
          jobInstance,
          connection.key,
          connection.metadata,
          connection.usesLocalAuth,
          connection.id
        )
      );
    }

    // Delete any connections that are no longer in the job
    await this.#prismaClient.jobConnection.deleteMany({
      where: {
        jobInstanceId: jobInstance.id,
        id: {
          notIn: upsertedConnections.map((c) => c.id),
        },
      },
    });

    // Count the number of job instances that have higher version numbers
    const laterJobInstanceCount = await this.#prismaClient.jobInstance.count({
      where: {
        jobId: job.id,
        version: {
          gt: apiJob.version,
        },
        environmentId: environment.id,
      },
    });

    // If there are no later job instances, then we can upsert the latest jobalias
    if (laterJobInstanceCount === 0) {
      // upsert the latest jobalias
      await this.#prismaClient.jobAlias.upsert({
        where: {
          jobId_environmentId_name: {
            jobId: job.id,
            environmentId: environment.id,
            name: "latest",
          },
        },
        create: {
          jobId: job.id,
          jobInstanceId: jobInstance.id,
          environmentId: environment.id,
          name: "latest",
          version: jobInstance.version,
        },
        update: {
          jobInstanceId: jobInstance.id,
          version: jobInstance.version,
        },
      });
    }

    const connectionsReady = await allConnectionsReady(upsertedConnections);

    // upsert the eventrule
    // The event rule should only be enabled if all the external connections are ready
    await this.#prismaClient.jobEventRule.upsert({
      where: {
        jobInstanceId_actionIdentifier: {
          jobInstanceId: jobInstance.id,
          actionIdentifier: "__trigger",
        },
      },
      create: {
        event: apiJob.trigger.eventRule.event,
        source: apiJob.trigger.eventRule.source,
        payloadFilter: apiJob.trigger.eventRule.payload,
        contextFilter: apiJob.trigger.eventRule.context,
        jobId: job.id,
        jobInstanceId: jobInstance.id,
        environmentId: environment.id,
        organizationId: environment.organizationId,
        projectId: environment.projectId,
        enabled: connectionsReady,
        actionIdentifier: "__trigger",
      },
      update: {
        event: apiJob.trigger.eventRule.event,
        source: apiJob.trigger.eventRule.source,
        payloadFilter: apiJob.trigger.eventRule.payload,
        contextFilter: apiJob.trigger.eventRule.context,
        enabled: connectionsReady,
      },
    });
  }

  async #upsertJobConnection(
    job: Job & {
      connections: Array<
        JobConnection & { apiConnection: ApiConnection | null }
      >;
    },
    jobInstance: JobInstance & {
      connections: Array<
        JobConnection & { apiConnection: ApiConnection | null }
      >;
    },
    key: string,
    metadata: ConnectionMetadata,
    usesLocalAuth: boolean,
    id?: string
  ): Promise<JobConnection> {
    if (usesLocalAuth) {
      return this.#upsertLocalAuthConnection(job, jobInstance, key, metadata);
    }

    if (!id) {
      logger.debug("Missing connection id", {
        key,
        metadata,
        usesLocalAuth,
        job,
      });

      throw new Error("Missing connection id");
    }

    const apiConnection =
      await this.#prismaClient.apiConnection.findUniqueOrThrow({
        where: {
          organizationId_slug: {
            organizationId: job.organizationId,
            slug: id,
          },
        },
      });

    // Find existing connection in the job instance
    const existingInstanceConnection = jobInstance.connections.find(
      (connection) => connection.key === key
    );

    if (existingInstanceConnection) {
      return await this.#prismaClient.jobConnection.update({
        where: {
          id: existingInstanceConnection.id,
        },
        data: {
          apiConnectionId: apiConnection.id,
          usesLocalAuth: false,
        },
      });
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
          apiConnection: {
            connect: {
              id: apiConnection.id,
            },
          },
          usesLocalAuth: false,
        },
      });
    }

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
        apiConnection: {
          connect: {
            id: apiConnection.id,
          },
        },
        usesLocalAuth,
      },
    });
  }

  async #upsertLocalAuthConnection(
    job: Job & {
      connections: Array<
        JobConnection & { apiConnection: ApiConnection | null }
      >;
    },
    jobInstance: JobInstance & {
      connections: Array<
        JobConnection & { apiConnection: ApiConnection | null }
      >;
    },
    key: string,
    metadata: ConnectionMetadata
  ): Promise<JobConnection> {
    // Find existing connection in the job instance
    const existingInstanceConnection = jobInstance.connections.find(
      (connection) => connection.key === key
    );

    if (
      existingInstanceConnection &&
      existingInstanceConnection.apiConnectionId
    ) {
      return await this.#prismaClient.jobConnection.update({
        where: {
          id: existingInstanceConnection.id,
        },
        data: {
          apiConnectionId: null,
          usesLocalAuth: true,
        },
      });
    }

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
          usesLocalAuth: true,
        },
      });
    }

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
        usesLocalAuth: true,
      },
    });
  }
}

// Compares two semver strings and returns the type of update, either EQUAL, PATCH, MINOR, or MAJOR
function getSemverUpdate(
  latestVersion: string | undefined,
  newVersion: string | undefined
) {
  const latest = semver.coerce(latestVersion);
  const newV = semver.coerce(newVersion);

  if (!latest || !newV) {
    return "EQUAL";
  }

  if (semver.eq(latest, newV)) {
    return "EQUAL";
  }

  if (semver.lt(latest, newV)) {
    if (semver.major(latest) === semver.major(newV)) {
      if (semver.minor(latest) === semver.minor(newV)) {
        return "PATCH";
      }

      return "MINOR";
    }

    return "MAJOR";
  }

  return "EQUAL";
}
