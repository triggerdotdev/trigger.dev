import { type IntegrationConfig , type JobMetadata , SCHEDULED_EVENT , type TriggerMetadata } from '@trigger.dev/core/schemas';
import { assertExhaustive } from '@trigger.dev/core/utils';
import type { Endpoint, Integration, Job, JobIntegration, JobVersion } from "@trigger.dev/database";
import { prisma ,type  PrismaClient  } from "~/db.server";
import { type ExtendedEndpoint, findEndpoint } from "~/models/endpoint.server";
import type { RuntimeEnvironment } from "~/models/runtimeEnvironment.server";
import { putConcurrencyLimitGroup, putJobConcurrencyLimit } from "~/v3/marqs/v2.server";
import type { AuthenticatedEnvironment } from "../apiAuth.server";
import { logger } from "../logger.server";
import { RegisterScheduleSourceService } from "../schedules/registerScheduleSource.server";
import { executionRateLimiter } from "../runExecutionRateLimiter.server";

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
        integration = await this.#upsertIntegrationForJobIntegration(environment, jobIntegration);
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

    const { examples, ...eventSpecification } = metadata.event;

    // Job Queues are going to be deprecated or used for something else, we're just doing this for now
    const concurrencyLimitGroup =
      typeof metadata.concurrencyLimit === "object"
        ? await this.#prismaClient.concurrencyLimitGroup.upsert({
            where: {
              environmentId_name: {
                environmentId: environment.id,
                name: metadata.concurrencyLimit.id,
              },
            },
            create: {
              environmentId: environment.id,
              name: metadata.concurrencyLimit.id,
              concurrencyLimit: metadata.concurrencyLimit.limit,
            },
            update: {
              concurrencyLimit: metadata.concurrencyLimit.limit,
            },
          })
        : null;

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
        jobId: job.id,
        endpointId: endpoint.id,
        environmentId: environment.id,
        organizationId: environment.organizationId,
        projectId: environment.projectId,
        version: metadata.version,
        eventSpecification,
        preprocessRuns: metadata.preprocessRuns,
        startPosition: "LATEST",
        status: "ACTIVE",
        concurrencyLimitGroupId: concurrencyLimitGroup?.id ?? null,
        concurrencyLimit:
          typeof metadata.concurrencyLimit === "number" ? metadata.concurrencyLimit : null,
      },
      update: {
        status: "ACTIVE",
        startPosition: "LATEST",
        eventSpecification,
        preprocessRuns: metadata.preprocessRuns,
        endpointId: endpoint.id,
        concurrencyLimitGroupId: concurrencyLimitGroup?.id ?? null,
        concurrencyLimit:
          typeof metadata.concurrencyLimit === "number" ? metadata.concurrencyLimit : null,
      },
      include: {
        integrations: {
          include: {
            integration: true,
          },
        },
        concurrencyLimitGroup: true,
      },
    });

    try {
      if (jobVersion.concurrencyLimitGroup) {
        // Upsert the maxSize for the concurrency limit group (marqs v2)
        await putConcurrencyLimitGroup(jobVersion.concurrencyLimitGroup, environment);

        // Upsert the maxSize for the concurrency limit group (legacy)
        await executionRateLimiter?.putConcurrencyLimitGroup(
          jobVersion.concurrencyLimitGroup,
          environment
        );
      }

      await putJobConcurrencyLimit(job, jobVersion, environment);
      await executionRateLimiter?.putJobVersionConcurrencyLimit(jobVersion, environment);
    } catch (error) {
      logger.error("Error setting concurrency limit", {
        error,
        jobVersionId: jobVersion.id,
        environmentId: environment.id,
      });
    }

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
            icon: example.icon ?? null,
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

        if (trigger.properties || trigger.link || trigger.help) {
          await this.#prismaClient.jobVersion.update({
            where: {
              id: jobVersion.id,
            },
            data: {
              properties: trigger.properties,
              triggerLink: trigger.link,
              triggerHelp: trigger.help,
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
          organizationId: job.organizationId,
        });

        break;
      }
    }
  }

  async #upsertIntegrationForJobIntegration(
    environment: AuthenticatedEnvironment,
    jobIntegration: IntegrationConfig
  ): Promise<Integration> {
    switch (jobIntegration.authSource) {
      case "LOCAL": {
        return await this.#prismaClient.integration.upsert({
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
            setupStatus: "COMPLETE",
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
      case "HOSTED": {
        return await this.#prismaClient.integration.create({
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
      case "RESOLVER": {
        return await this.#prismaClient.integration.upsert({
          where: {
            organizationId_slug: {
              organizationId: environment.organizationId,
              slug: jobIntegration.id,
            },
          },
          create: {
            slug: jobIntegration.id,
            title: jobIntegration.metadata.name,
            authSource: "RESOLVER",
            connectionType: "EXTERNAL",
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
            authSource: "RESOLVER",
            connectionType: "EXTERNAL",
            setupStatus: "COMPLETE",
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
      default: {
        assertExhaustive(jobIntegration.authSource);
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
