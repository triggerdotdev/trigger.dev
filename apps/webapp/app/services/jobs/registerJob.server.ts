import type {
  Endpoint,
  Job,
  JobIntegration,
  JobVersion,
  ApiConnectionClient,
} from ".prisma/client";
import type {
  IntegrationConfig,
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

    const integrationSlugs = new Set<string>();

    if (metadata.integrations) {
      for (const integration of Object.values(metadata.integrations)) {
        integrationSlugs.add(integration.id);
      }
    }

    const apiConnectionClients = new Map<string, ApiConnectionClient>();

    for (const integrationSlug of integrationSlugs) {
      const apiConnectionClient =
        await this.#prismaClient.apiConnectionClient.findUnique({
          where: {
            organizationId_slug: {
              organizationId: environment.organizationId,
              slug: integrationSlug,
            },
          },
        });

      if (!apiConnectionClient) {
        // TODO: find a better way to handle and message the user about this issue
        throw new Error(
          `Could not find ApiConnectionClient with slug ${integrationSlug}`
        );
      }

      apiConnectionClients.set(integrationSlug, apiConnectionClient);
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
        integrations: {
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
        integrations: {
          include: {
            apiConnectionClient: true,
          },
        },
      },
    });

    const jobIntegrations = new Set<string>();

    // Upsert the job integrations
    for (const [key, integration] of Object.entries(metadata.integrations)) {
      const jobIntegration = await this.#upsertJobIntegration(
        job,
        jobVersion,
        integration,
        apiConnectionClients,
        key
      );

      jobIntegrations.add(jobIntegration.id);
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

    await this.#prismaClient.jobIntegration.deleteMany({
      where: {
        versionId: jobVersion.id,
        id: {
          notIn: Array.from(jobIntegrations),
        },
      },
    });

    for (const trigger of metadata.triggers) {
      await this.#upsertEventDispatcher(trigger, job, jobVersion, environment);
    }

    return jobVersion;
  }

  async #upsertEventDispatcher(
    trigger: TriggerMetadata,
    job: Job,
    jobVersion: JobVersion,
    environment: RuntimeEnvironment
  ) {
    if (trigger.type === "static") {
      await this.#prismaClient.eventDispatcher.upsert({
        where: {
          dispatchableId_environmentId: {
            dispatchableId: job.id,
            environmentId: environment.id,
          },
        },
        create: {
          event: trigger.rule.event,
          source: trigger.rule.source,
          payloadFilter: trigger.rule.payload,
          contextFilter: trigger.rule.context,
          environmentId: environment.id,
          enabled: true,
          dispatchable: {
            type: "JOB_VERSION",
            id: jobVersion.id,
          },
          dispatchableId: job.id,
        },
        update: {
          event: trigger.rule.event,
          source: trigger.rule.source,
          payloadFilter: trigger.rule.payload,
          contextFilter: trigger.rule.context,
          dispatchable: {
            type: "JOB_VERSION",
            id: jobVersion.id,
          },
        },
      });
    }
  }

  async #upsertJobIntegration(
    job: Job & {
      integrations: Array<
        JobIntegration & { apiConnectionClient: ApiConnectionClient | null }
      >;
    },
    jobVersion: JobVersion & {
      integrations: Array<
        JobIntegration & { apiConnectionClient: ApiConnectionClient | null }
      >;
    },
    config: IntegrationConfig,
    apiConnectionClients: Map<string, ApiConnectionClient>,
    key: string
  ): Promise<JobIntegration> {
    const apiConnectionClient = apiConnectionClients.get(config.id);

    if (!apiConnectionClient) {
      throw new Error(
        `Could not find api connection client with id ${config.id} for job ${job.id}`
      );
    }

    // Find existing integration in the job instance
    const existingInstanceConnection = jobVersion.integrations.find(
      (integration) => integration.key === key
    );

    if (existingInstanceConnection) {
      return await this.#prismaClient.jobIntegration.update({
        where: {
          id: existingInstanceConnection.id,
        },
        data: {
          apiConnectionClientId: apiConnectionClient.id,
        },
      });
    }

    // Find existing connection in the job
    const existingJobIntegration = job.integrations.find(
      (integration) => integration.key === key
    );

    if (existingJobIntegration) {
      logger.debug("Creating new job integration from existing", {
        existingJobIntegration,
        key,
        jobVersionId: jobVersion.id,
      });

      return this.#prismaClient.jobIntegration.create({
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
          metadata: existingJobIntegration.metadata ?? {},
          apiConnectionClient: {
            connect: {
              id: apiConnectionClient.id,
            },
          },
        },
      });
    }

    logger.debug("Creating new job integration", {
      key,
      jobVersionId: jobVersion.id,
      config,
    });

    return this.#prismaClient.jobIntegration.create({
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
        metadata: config.metadata,
        apiConnectionClient: {
          connect: {
            id: apiConnectionClient.id,
          },
        },
      },
    });
  }
}
