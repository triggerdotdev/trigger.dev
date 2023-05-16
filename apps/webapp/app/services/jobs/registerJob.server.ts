import type {
  Endpoint,
  Job,
  JobConnection,
  JobVersion,
  ApiConnectionClient,
} from ".prisma/client";
import type {
  ConnectionConfig,
  JobMetadata,
  TriggerMetadata,
} from "@trigger.dev/internal";
import { DEFAULT_MAX_CONCURRENT_RUNS } from "~/consts";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import type { AuthenticatedEnvironment } from "../apiAuth.server";
import { logger } from "../logger";
import type { RuntimeEnvironment } from "~/models/runtimeEnvironment.server";

export class RegisterJobService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(endpointId: string, metadata: JobMetadata) {
    const endpoint = await this.#prismaClient.endpoint.findUniqueOrThrow({
      where: {
        id: endpointId,
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

    await this.#upsertJob(endpoint, endpoint.environment, metadata);
  }

  async #upsertJob(
    endpoint: Endpoint,
    environment: AuthenticatedEnvironment,
    metadata: JobMetadata
  ): Promise<JobVersion> {
    logger.debug("Upserting job", {
      endpoint,
      organizationId: environment.organizationId,
      metadata,
    });

    // Make sure all the hosted connections exist before we upsert the job
    // Need to check for three places where a connection could be:
    // 1. The job.connections
    // 2. The job.trigger possible connection
    // 3. The job.triggerVariants possible connection
    const connectionSlugs = new Set<string>();

    if (metadata.connections) {
      for (const connection of Object.values(metadata.connections)) {
        connectionSlugs.add(connection.id);
      }
    }

    const apiConnectionClients = new Map<string, ApiConnectionClient>();

    for (const connectionSlug of connectionSlugs) {
      const apiConnectionClient =
        await this.#prismaClient.apiConnectionClient.findUnique({
          where: {
            organizationId_slug: {
              organizationId: environment.organizationId,
              slug: connectionSlug,
            },
          },
        });

      if (!apiConnectionClient) {
        // TODO: find a better way to handle and message the user about this issue
        throw new Error(
          `Could not find ApiConnectionClient with slug ${connectionSlug}`
        );
      }

      apiConnectionClients.set(connectionSlug, apiConnectionClient);
    }

    // Upsert the Job
    const job = await this.#prismaClient.job.upsert({
      where: {
        projectId_slug: {
          projectId: environment.projectId,
          slug: metadata.id,
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
        slug: metadata.id,
        title: metadata.name,
        internal: metadata.internal,
      },
      update: {
        title: metadata.name,
      },
      include: {
        connections: {
          include: {
            apiConnectionClient: true,
          },
        },
      },
    });

    // Upsert the JobQueue
    const queueName =
      typeof metadata.queue === "string"
        ? metadata.queue
        : typeof metadata.queue === "object"
        ? metadata.queue.name
        : "default";

    const jobQueue = await this.#prismaClient.jobQueue.upsert({
      where: {
        environmentId_name: {
          environmentId: environment.id,
          name: queueName,
        },
      },
      create: {
        environment: {
          connect: {
            id: environment.id,
          },
        },
        name: queueName,
        maxJobs:
          typeof metadata.queue === "object"
            ? metadata.queue.maxConcurrent || DEFAULT_MAX_CONCURRENT_RUNS
            : DEFAULT_MAX_CONCURRENT_RUNS,
      },
      update: {
        maxJobs:
          typeof metadata.queue === "object"
            ? metadata.queue.maxConcurrent || DEFAULT_MAX_CONCURRENT_RUNS
            : DEFAULT_MAX_CONCURRENT_RUNS,
      },
    });

    // Upsert the JobVersion
    const jobVersion = await this.#prismaClient.jobVersion.upsert({
      where: {
        jobId_version_endpointId: {
          jobId: job.id,
          version: metadata.version,
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
        queue: {
          connect: {
            id: jobQueue.id,
          },
        },
        version: metadata.version,
        eventSpecification: metadata.event,
        startPosition:
          metadata.startPosition === "initial" ? "INITIAL" : "LATEST",
      },
      update: {
        startPosition:
          metadata.startPosition === "initial" ? "INITIAL" : "LATEST",
        eventSpecification: metadata.event,
        queue: {
          connect: {
            id: jobQueue.id,
          },
        },
      },
      include: {
        connections: {
          include: {
            apiConnectionClient: true,
          },
        },
      },
    });

    const jobConnections = new Set<string>();

    // Upsert the job connections
    for (const [key, connection] of Object.entries(metadata.connections)) {
      const jobConnection = await this.#upsertJobConnection(
        job,
        jobVersion,
        connection,
        apiConnectionClients,
        key
      );

      jobConnections.add(jobConnection.id);
    }

    // Count the number of job instances that have higher version numbers
    const laterJobVersionCount = await this.#prismaClient.jobVersion.count({
      where: {
        jobId: job.id,
        version: {
          gt: metadata.version,
        },
        environmentId: environment.id,
      },
    });

    // If there are no later job instances, then we can upsert the latest jobalias
    if (laterJobVersionCount === 0) {
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
          versionId: jobVersion.id,
          environmentId: environment.id,
          name: "latest",
          value: jobVersion.version,
        },
        update: {
          versionId: jobVersion.id,
          value: jobVersion.version,
        },
      });
    }

    // Delete any connections that are no longer in the job
    // It's import this runs after the trigger variant upserts
    await this.#prismaClient.jobConnection.deleteMany({
      where: {
        versionId: jobVersion.id,
        id: {
          notIn: Array.from(jobConnections),
        },
      },
    });

    // This is where we upsert the triggers if there are any
    // upsert the eventrule
    // The event rule should only be enabled if all the external connections are ready
    for (const trigger of metadata.triggers) {
      await this.#upsertTrigger(
        trigger,
        jobVersion,
        job,
        environment,
        endpoint
      );
    }

    return jobVersion;
  }

  async #upsertTrigger(
    trigger: TriggerMetadata,
    jobVersion: JobVersion,
    job: Job,
    environment: RuntimeEnvironment,
    endpoint: Endpoint
  ) {
    if (trigger.type === "static") {
      await this.#prismaClient.jobTrigger.upsert({
        where: {
          versionId_actionIdentifier: {
            versionId: jobVersion.id,
            actionIdentifier: "__trigger",
          },
        },
        create: {
          event: trigger.rule.event,
          source: trigger.rule.source,
          payloadFilter: trigger.rule.payload,
          contextFilter: trigger.rule.context,
          jobId: job.id,
          versionId: jobVersion.id,
          environmentId: environment.id,
          organizationId: environment.organizationId,
          projectId: environment.projectId,
          enabled: true,
          actionIdentifier: "__trigger",
        },
        update: {
          event: trigger.rule.event,
          source: trigger.rule.source,
          payloadFilter: trigger.rule.payload,
          contextFilter: trigger.rule.context,
        },
      });
    } else {
      await this.#prismaClient.dynamicTrigger.upsert({
        where: {
          endpointId_slug: {
            endpointId: endpoint.id,
            slug: trigger.id,
          },
        },
        create: {
          slug: trigger.id,
          endpoint: {
            connect: {
              id: endpoint.id,
            },
          },
          jobs: {
            connect: {
              id: job.id,
            },
          },
        },
        update: {
          jobs: {
            connect: {
              id: job.id,
            },
          },
        },
      });
    }
  }

  async #upsertJobConnection(
    job: Job & {
      connections: Array<
        JobConnection & { apiConnectionClient: ApiConnectionClient | null }
      >;
    },
    jobVersion: JobVersion & {
      connections: Array<
        JobConnection & { apiConnectionClient: ApiConnectionClient | null }
      >;
    },
    config: ConnectionConfig,
    apiConnectionClients: Map<string, ApiConnectionClient>,
    key: string
  ): Promise<JobConnection> {
    const apiConnectionClient = apiConnectionClients.get(config.id);

    if (!apiConnectionClient) {
      throw new Error(
        `Could not find api connection client with id ${config.id} for job ${job.id}`
      );
    }

    // Find existing connection in the job instance
    const existingInstanceConnection = jobVersion.connections.find(
      (connection) => connection.key === key
    );

    if (existingInstanceConnection) {
      return await this.#prismaClient.jobConnection.update({
        where: {
          id: existingInstanceConnection.id,
        },
        data: {
          apiConnectionClientId: apiConnectionClient.id,
        },
      });
    }

    // Find existing connection in the job
    const existingJobConnection = job.connections.find(
      (connection) => connection.key === key
    );

    if (existingJobConnection) {
      logger.debug("Creating new job connection from existing", {
        existingJobConnection,
        key,
        jobVersionId: jobVersion.id,
      });

      return this.#prismaClient.jobConnection.create({
        data: {
          version: {
            connect: {
              id: jobVersion.id,
            },
          },
          job: {
            connect: {
              id: job.id,
            },
          },
          key,
          connectionMetadata: existingJobConnection.connectionMetadata ?? {},
          apiConnectionClient: {
            connect: {
              id: apiConnectionClient.id,
            },
          },
        },
      });
    }

    logger.debug("Creating new job connection", {
      key,
      jobVersionId: jobVersion.id,
      config,
    });

    return this.#prismaClient.jobConnection.create({
      data: {
        version: {
          connect: {
            id: jobVersion.id,
          },
        },
        job: {
          connect: {
            id: job.id,
          },
        },
        key,
        connectionMetadata: config.metadata,
        apiConnectionClient: {
          connect: {
            id: apiConnectionClient.id,
          },
        },
      },
    });
  }
}
