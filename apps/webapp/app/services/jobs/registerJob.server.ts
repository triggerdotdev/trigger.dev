import {
  IntegrationConfig,
  JobMetadata,
  SCHEDULED_EVENT,
  TriggerMetadata,
} from "@trigger.dev/core";
import type { Endpoint, Integration, Job, JobIntegration, JobVersion } from "@trigger.dev/database";
import { DEFAULT_MAX_CONCURRENT_RUNS } from "~/consts";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { ExtendedEndpoint, findEndpoint } from "~/models/endpoint.server";
import type { RuntimeEnvironment } from "~/models/runtimeEnvironment.server";
import type { AuthenticatedEnvironment } from "../apiAuth.server";
import { logger } from "../logger.server";
import { RegisterScheduleSourceService } from "../schedules/registerScheduleSource.server";

export class RegisterJobService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(endpointIdOrEndpoint: string | ExtendedEndpoint, metadata: JobMetadata) {
    const endpoint =
      typeof endpointIdOrEndpoint === "string"
        ? await findEndpoint(endpointIdOrEndpoint)
        : endpointIdOrEndpoint;

    return this.#upsertJob(endpoint, endpoint.environment, metadata);
  }

  async #upsertJob(
    endpoint: Endpoint,
    environment: AuthenticatedEnvironment,
    metadata: JobMetadata
  ): Promise<JobVersion | undefined> {
    // Check the job doesn't already exist and is deleted
    const existingJob = await this.#prismaClient.job.findUnique({
      where: {
        projectId_slug: {
          projectId: environment.projectId,
          slug: metadata.id,
        },
      },
    });

    if (existingJob && existingJob.deletedAt && !metadata.enabled) {
      return;
    }

    const integrations = new Map<string, Integration>();

    for (const [, jobIntegration] of Object.entries(metadata.integrations)) {
      let integration = await this.#prismaClient.integration.findUnique({
        where: {
          organizationId_slug: {
            organizationId: environment.organizationId,
            slug: jobIntegration.id,
          },
        },
      });

      if (!integration) {
        if (jobIntegration.authSource === "LOCAL") {
          integration = await this.#prismaClient.integration.upsert({
            where: {
              organizationId_slug: {
                organizationId: environment.organizationId,
                slug: jobIntegration.id,
              },
            },
            create: {
              slug: jobIntegration.id,
              title: jobIntegration.metadata.name,
              authSource: "LOCAL",
              connectionType: "DEVELOPER",
              organization: {
                connect: {
                  id: environment.organizationId,
                },
              },
              definition: {
                connectOrCreate: {
                  where: {
                    id: jobIntegration.metadata.id,
                  },
                  create: {
                    id: jobIntegration.metadata.id,
                    name: jobIntegration.metadata.name,
                    instructions: jobIntegration.metadata.instructions,
                  },
                },
              },
            },
            update: {
              title: jobIntegration.metadata.name,
              authSource: "LOCAL",
              connectionType: "DEVELOPER",
              definition: {
                connectOrCreate: {
                  where: {
                    id: jobIntegration.metadata.id,
                  },
                  create: {
                    id: jobIntegration.metadata.id,
                    name: jobIntegration.metadata.name,
                    instructions: jobIntegration.metadata.instructions,
                  },
                },
              },
            },
          });
        } else {
          integration = await this.#prismaClient.integration.create({
            data: {
              slug: jobIntegration.id,
              title: jobIntegration.id,
              authSource: "HOSTED",
              setupStatus: "MISSING_FIELDS",
              connectionType: "DEVELOPER",
              organization: {
                connect: {
                  id: environment.organizationId,
                },
              },
              definition: {
                connectOrCreate: {
                  where: {
                    id: jobIntegration.metadata.id,
                  },
                  create: {
                    id: jobIntegration.metadata.id,
                    name: jobIntegration.metadata.name,
                    instructions: jobIntegration.metadata.instructions,
                  },
                },
              },
            },
          });
        }
      }

      integrations.set(jobIntegration.id, integration);
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
        deletedAt: metadata.enabled ? null : undefined,
      },
      include: {
        integrations: {
          include: {
            integration: true,
          },
        },
      },
    });

    // Upsert the JobQueue
    const queueName = "default";

    // Job Queues are going to be deprecated or used for something else, we're just doing this for now
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
        maxJobs: DEFAULT_MAX_CONCURRENT_RUNS,
      },
      update: {
        maxJobs: DEFAULT_MAX_CONCURRENT_RUNS,
      },
    });

    const { examples, ...eventSpecification } = metadata.event;

    // Upsert the JobVersion
    const jobVersion = await this.#prismaClient.jobVersion.upsert({
      where: {
        jobId_version_environmentId: {
          jobId: job.id,
          version: metadata.version,
          environmentId: environment.id,
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
        eventSpecification,
        preprocessRuns: metadata.preprocessRuns,
        startPosition: "LATEST",
        status: "ACTIVE",
      },
      update: {
        status: "ACTIVE",
        startPosition: "LATEST",
        eventSpecification,
        preprocessRuns: metadata.preprocessRuns,
        queue: {
          connect: {
            id: jobQueue.id,
          },
        },
        endpoint: {
          connect: {
            id: endpoint.id,
          },
        },
      },
      include: {
        integrations: {
          include: {
            integration: true,
          },
        },
      },
    });

    // Upsert the examples and delete any that are no longer in the metadata
    const upsertedExamples = new Set<string>();
    if (examples) {
      for (const example of examples) {
        const e = await this.#prismaClient.eventExample.upsert({
          where: {
            slug_jobVersionId: {
              slug: example.id,
              jobVersionId: jobVersion.id,
            },
          },
          create: {
            slug: example.id,
            name: example.name,
            icon: example.icon,
            jobVersionId: jobVersion.id,
            payload: example.payload,
          },
          update: {
            name: example.name,
            icon: example.icon,
            payload: example.payload,
          },
        });

        upsertedExamples.add(e.id);
      }
    }
    await this.#prismaClient.eventExample.deleteMany({
      where: {
        jobVersionId: jobVersion.id,
        id: {
          notIn: Array.from(upsertedExamples),
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
        integrations,
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

    await this.#upsertEventDispatcher(metadata.trigger, job, jobVersion, environment);

    return jobVersion;
  }

  async #upsertEventDispatcher(
    trigger: TriggerMetadata,
    job: Job,
    jobVersion: JobVersion,
    environment: RuntimeEnvironment
  ) {
    switch (trigger.type) {
      case "static": {
        await this.#prismaClient.eventDispatcher.upsert({
          where: {
            dispatchableId_environmentId: {
              dispatchableId: job.id,
              environmentId: environment.id,
            },
          },
          create: {
            event:
              typeof trigger.rule.event === "string" ? [trigger.rule.event] : trigger.rule.event,
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
            event:
              typeof trigger.rule.event === "string" ? [trigger.rule.event] : trigger.rule.event,
            source: trigger.rule.source,
            payloadFilter: trigger.rule.payload,
            contextFilter: trigger.rule.context,
            dispatchable: {
              type: "JOB_VERSION",
              id: jobVersion.id,
            },
            enabled: true,
          },
        });

        if (trigger.properties) {
          await this.#prismaClient.jobVersion.update({
            where: {
              id: jobVersion.id,
            },
            data: {
              properties: trigger.properties,
            },
          });
        }

        break;
      }
      case "scheduled": {
        const eventDispatcher = await this.#prismaClient.eventDispatcher.upsert({
          where: {
            dispatchableId_environmentId: {
              dispatchableId: job.id,
              environmentId: environment.id,
            },
          },
          create: {
            event: [SCHEDULED_EVENT],
            source: "trigger.dev",
            payloadFilter: {},
            contextFilter: {},
            environmentId: environment.id,
            enabled: true,
            dispatchable: {
              type: "JOB_VERSION",
              id: jobVersion.id,
            },
            dispatchableId: job.id,
            manual: true,
          },
          update: {
            dispatchable: {
              type: "JOB_VERSION",
              id: jobVersion.id,
            },
            enabled: true,
          },
        });

        const service = new RegisterScheduleSourceService();

        await service.call({
          key: job.id,
          dispatcher: eventDispatcher,
          schedule: trigger.schedule,
        });

        break;
      }
    }
  }

  async #upsertJobIntegration(
    job: Job & {
      integrations: Array<JobIntegration & { integration: Integration | null }>;
    },
    jobVersion: JobVersion & {
      integrations: Array<JobIntegration & { integration: Integration | null }>;
    },
    config: IntegrationConfig,
    integrations: Map<string, Integration>,
    key: string
  ): Promise<JobIntegration> {
    const integration = integrations.get(config.id);

    if (!integration) {
      throw new Error(`Could not find integration with id ${config.id} for job ${job.id}`);
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
          integrationId: integration.id,
        },
      });
    }

    // Find existing connection in the job
    const existingJobIntegration = job.integrations.find((integration) => integration.key === key);

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
          integration: {
            connect: {
              id: integration.id,
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
        integration: {
          connect: {
            id: integration.id,
          },
        },
      },
    });
  }
}
