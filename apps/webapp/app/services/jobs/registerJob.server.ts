import type {
  ApiConnection,
  Endpoint,
  Job,
  JobConnection,
  JobInstance,
  JobTriggerVariant,
} from ".prisma/client";
import type {
  ConnectionConfig,
  GetJobResponse,
  LocalAuthConnectionConfig,
  TriggerMetadata,
} from "@trigger.dev/internal";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import type { AuthenticatedEnvironment } from "../apiAuth.server";
import { logger } from "../logger";
import { workerQueue } from "../worker.server";

export class RegisterJobService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(endpointId: string, jobResponse: GetJobResponse) {
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

    const jobInstance = await this.#upsertJob(
      endpoint,
      endpoint.environment,
      jobResponse
    );

    await workerQueue.enqueue(
      "prepareJobInstance",
      { id: jobInstance.id },
      { queueName: `endpoint-${endpoint.id}` }
    );
  }

  async #upsertJob(
    endpoint: Endpoint,
    environment: AuthenticatedEnvironment,
    jobResponse: GetJobResponse
  ): Promise<JobInstance> {
    const { metadata, triggerVariants } = jobResponse;

    logger.debug("Upserting job", {
      endpoint,
      organizationId: environment.organizationId,
      metadata,
      triggerVariants,
    });

    // Make sure all the hosted connections exist before we upsert the job
    // Need to check for three places where a connection could be:
    // 1. The job.connections
    // 2. The job.trigger possible connection
    // 3. The job.triggerVariants possible connection
    const connectionSlugs = new Set<string>();

    if (metadata.connections) {
      for (const connection of metadata.connections) {
        if (connection.auth === "hosted") {
          connectionSlugs.add(connection.id);
        }
      }
    }

    if (
      metadata.trigger.connection &&
      metadata.trigger.connection.auth === "hosted"
    ) {
      connectionSlugs.add(metadata.trigger.connection.id);
    }

    if (triggerVariants) {
      for (const triggerVariant of triggerVariants) {
        if (
          triggerVariant.trigger.connection &&
          triggerVariant.trigger.connection.auth === "hosted"
        ) {
          connectionSlugs.add(triggerVariant.trigger.connection.id);
        }
      }
    }

    const apiConnections = new Map<string, ApiConnection>();

    for (const connectionSlug of connectionSlugs) {
      const apiConnection = await this.#prismaClient.apiConnection.findUnique({
        where: {
          organizationId_slug: {
            organizationId: environment.organizationId,
            slug: connectionSlug,
          },
        },
      });

      if (!apiConnection) {
        // todo: find a better way to handle and message the user about this issue
        throw new Error(
          `Could not find ApiConnection with slug ${connectionSlug}`
        );
      }

      apiConnections.set(connectionSlug, apiConnection);
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
      },
      update: {
        title: metadata.name,
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
          include: {
            triggerVariants: true,
          },
        },
      },
    });

    const latestInstance = job.instances[0];

    let ready = false;

    if (typeof latestInstance !== "undefined") {
      ready = latestInstance.ready;
    } else {
      ready = !metadata.trigger.supportsPreparation;
    }

    // Upsert the JobInstance
    const jobInstance = await this.#prismaClient.jobInstance.upsert({
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
        version: metadata.version,
        trigger: metadata.trigger,
        ready,
      },
      update: {
        trigger: metadata.trigger,
      },
      include: {
        connections: {
          include: {
            apiConnection: true,
          },
        },
      },
    });

    const jobConnections = new Set<string>();

    if (metadata.trigger.connection) {
      const triggerConnection = await this.#upsertJobConnection(
        job,
        jobInstance,
        metadata.trigger.connection,
        apiConnections,
        "__trigger"
      );

      jobConnections.add(triggerConnection.id);
    }

    // Upsert the job connections
    for (const connection of metadata.connections) {
      const jobConnection = await this.#upsertJobConnection(
        job,
        jobInstance,
        connection,
        apiConnections
      );

      jobConnections.add(jobConnection.id);
    }

    // Count the number of job instances that have higher version numbers
    const laterJobInstanceCount = await this.#prismaClient.jobInstance.count({
      where: {
        jobId: job.id,
        version: {
          gt: metadata.version,
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

    if (triggerVariants) {
      for (const triggerVariant of triggerVariants) {
        const jobConnection = await this.#upsertTriggerVariant(
          job,
          jobInstance,
          environment,
          triggerVariant.id,
          triggerVariant.trigger,
          apiConnections,
          latestInstance?.triggerVariants
        );

        if (jobConnection) {
          jobConnections.add(jobConnection.id);
        }
      }
    }

    // Delete any connections that are no longer in the job
    // It's import this runs after the trigger variant upserts
    await this.#prismaClient.jobConnection.deleteMany({
      where: {
        jobInstanceId: jobInstance.id,
        id: {
          notIn: Array.from(jobConnections),
        },
      },
    });

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
        event: metadata.trigger.eventRule.event,
        source: metadata.trigger.eventRule.source,
        payloadFilter: metadata.trigger.eventRule.payload,
        contextFilter: metadata.trigger.eventRule.context,
        jobId: job.id,
        jobInstanceId: jobInstance.id,
        environmentId: environment.id,
        organizationId: environment.organizationId,
        projectId: environment.projectId,
        enabled: true,
        actionIdentifier: "__trigger",
      },
      update: {
        event: metadata.trigger.eventRule.event,
        source: metadata.trigger.eventRule.source,
        payloadFilter: metadata.trigger.eventRule.payload,
        contextFilter: metadata.trigger.eventRule.context,
      },
    });

    return jobInstance;
  }

  async #upsertTriggerVariant(
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
    environment: AuthenticatedEnvironment,
    id: string,
    trigger: TriggerMetadata,
    apiConnections: Map<string, ApiConnection>,
    previousVariants?: Array<JobTriggerVariant>
  ): Promise<JobConnection | undefined> {
    const previousVariant = previousVariants?.find((v) => v.id === id);

    await this.#prismaClient.jobTriggerVariant.upsert({
      where: {
        jobInstanceId_slug: {
          jobInstanceId: jobInstance.id,
          slug: id,
        },
      },
      create: {
        jobInstance: {
          connect: {
            id: jobInstance.id,
          },
        },
        slug: id,
        data: trigger,
        ready: trigger.supportsPreparation
          ? previousVariant
            ? previousVariant.ready
            : false
          : true,
        eventRule: {
          create: {
            event: trigger.eventRule.event,
            source: trigger.eventRule.source,
            payloadFilter: trigger.eventRule.payload,
            contextFilter: trigger.eventRule.context,
            jobId: job.id,
            jobInstanceId: jobInstance.id,
            environmentId: environment.id,
            organizationId: environment.organizationId,
            projectId: environment.projectId,
            enabled: true,
            actionIdentifier: `__trigger_${id}`,
          },
        },
      },
      update: {
        data: trigger,
      },
    });

    if (trigger.connection) {
      return await this.#upsertJobConnection(
        job,
        jobInstance,
        trigger.connection,
        apiConnections,
        `__trigger_${id}`
      );
    }
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
    config: ConnectionConfig,
    apiConnections: Map<string, ApiConnection>,
    overrideKey?: string
  ): Promise<JobConnection> {
    if (config.auth === "local") {
      return this.#upsertLocalAuthConnection(
        job,
        jobInstance,
        config,
        overrideKey
      );
    }

    const apiConnection = apiConnections.get(config.id);

    if (!apiConnection) {
      throw new Error(
        `Could not find api connection with id ${config.id} for job ${job.id}`
      );
    }

    const key = overrideKey ?? config.key;

    if (!key) {
      throw new Error(
        `Could not find key for connection ${config.id} for job ${job.id}`
      );
    }

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
      logger.debug("Creating new job connection from existing", {
        existingJobConnection,
        key,
        jobInstanceId: jobInstance.id,
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

    logger.debug("Creating new job connection", {
      key,
      jobInstanceId: jobInstance.id,
      config,
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
        connectionMetadata: config.metadata,
        apiConnection: {
          connect: {
            id: apiConnection.id,
          },
        },
        usesLocalAuth: false,
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
    config: LocalAuthConnectionConfig,
    overrideKey?: string
  ): Promise<JobConnection> {
    const key = overrideKey ?? config.key;

    if (!key) {
      throw new Error("Missing connection key");
    }

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
        connectionMetadata: config.metadata,
        usesLocalAuth: true,
      },
    });
  }
}
