import type { EndpointIndexSource } from "@trigger.dev/database";
import { PrismaClient, prisma } from "~/db.server";
import { findEndpoint } from "~/models/endpoint.server";
import { EndpointApi } from "../endpointApi.server";
import { RegisterJobService } from "../jobs/registerJob.server";
import { logger } from "../logger.server";
import { RegisterSourceServiceV1 } from "../sources/registerSourceV1.server";
import { RegisterDynamicScheduleService } from "../triggers/registerDynamicSchedule.server";
import { RegisterDynamicTriggerService } from "../triggers/registerDynamicTrigger.server";
import { DisableJobService } from "../jobs/disableJob.server";
import { RegisterSourceServiceV2 } from "../sources/registerSourceV2.server";
import { RegisterBackgroundTaskService } from "../backgroundTasks/registerBackgroundTask.server";
import { DisableBackgroundTaskService } from "../backgroundTasks/disableBackgroundTask.server";

export class IndexEndpointService {
  #prismaClient: PrismaClient;
  #registerJobService = new RegisterJobService();
  #disableJobService = new DisableJobService();
  #registerSourceServiceV1 = new RegisterSourceServiceV1();
  #registerSourceServiceV2 = new RegisterSourceServiceV2();
  #registerBackgroundTaskService = new RegisterBackgroundTaskService();
  #disableBackgroundTaskService = new DisableBackgroundTaskService();
  #registerDynamicTriggerService = new RegisterDynamicTriggerService();
  #registerDynamicScheduleService = new RegisterDynamicScheduleService();

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(
    id: string,
    source: EndpointIndexSource = "INTERNAL",
    reason?: string,
    sourceData?: any
  ) {
    const endpoint = await findEndpoint(id);

    // Make a request to the endpoint to fetch a list of jobs
    const client = new EndpointApi(endpoint.environment.apiKey, endpoint.url);

    const indexResponse = await client.indexEndpoint();

    if (!indexResponse.ok) {
      throw new Error(indexResponse.error);
    }

    const {
      jobs,
      sources,
      dynamicTriggers,
      dynamicSchedules,
      backgroundTasks = [],
    } = indexResponse.data;

    logger.debug("Indexing endpoint", {
      endpointId: endpoint.id,
      endpointUrl: endpoint.url,
      endpointSlug: endpoint.slug,
      source: source,
      sourceData: sourceData,
      stats: {
        jobs: jobs.length,
        sources: sources.length,
        dynamicTriggers: dynamicTriggers.length,
        dynamicSchedules: dynamicSchedules.length,
        backgroundTasks: backgroundTasks.length,
      },
    });

    const indexStats = {
      jobs: 0,
      backgroundTasks: 0,
      sources: 0,
      dynamicTriggers: 0,
      dynamicSchedules: 0,
      disabledJobs: 0,
      disabedBackgroundTasks: 0,
    };

    const existingJobs = await this.#prismaClient.job.findMany({
      where: {
        projectId: endpoint.projectId,
        deletedAt: null,
      },
      include: {
        aliases: {
          where: {
            name: "latest",
            environmentId: endpoint.environmentId,
          },
          include: {
            version: true,
          },
          take: 1,
        },
      },
    });

    for (const job of jobs) {
      if (!job.enabled) {
        const disabledJob = await this.#disableJobService
          .call(endpoint, { slug: job.id, version: job.version })
          .catch((error) => {
            logger.error("Failed to disable job", {
              endpointId: endpoint.id,
              job,
              error,
            });

            return;
          });

        if (disabledJob) {
          indexStats.disabledJobs++;
        }
      } else {
        try {
          const registeredVersion = await this.#registerJobService.call(endpoint, job);

          if (registeredVersion) {
            indexStats.jobs++;
          }
        } catch (error) {
          logger.error("Failed to register job", {
            endpointId: endpoint.id,
            job,
            error,
          });
        }
      }
    }

    // TODO: we need to do this for sources, dynamic triggers, and dynamic schedules
    const missingJobs = existingJobs.filter((job) => {
      return !jobs.find((j) => j.id === job.slug);
    });

    if (missingJobs.length > 0) {
      logger.debug("Disabling missing jobs", {
        endpointId: endpoint.id,
        missingJobIds: missingJobs.map((job) => job.slug),
      });

      for (const job of missingJobs) {
        const latestVersion = job.aliases[0]?.version;

        if (!latestVersion) {
          continue;
        }

        const disabledJob = await this.#disableJobService
          .call(endpoint, {
            slug: job.slug,
            version: latestVersion.version,
          })
          .catch((error) => {
            logger.error("Failed to disable job", {
              endpointId: endpoint.id,
              job,
              error,
            });

            return;
          });

        if (disabledJob) {
          indexStats.disabledJobs++;
        }
      }
    }

    const existingBackgroundTasks = await this.#prismaClient.backgroundTask.findMany({
      where: {
        projectId: endpoint.projectId,
        deletedAt: null,
      },
      include: {
        aliases: {
          where: {
            name: "latest",
            environmentId: endpoint.environmentId,
          },
          include: {
            version: true,
          },
          take: 1,
        },
      },
    });

    for (const backgroundTask of backgroundTasks) {
      if (!backgroundTask.enabled) {
        const disabledBackgroundTask = await this.#disableBackgroundTaskService
          .call(endpoint, { slug: backgroundTask.id, version: backgroundTask.version })
          .catch((error) => {
            logger.error("Failed to disable background task", {
              endpointId: endpoint.id,
              backgroundTask,
              error,
            });

            return;
          });

        if (disabledBackgroundTask) {
          indexStats.disabledJobs++;
        }
      } else {
        try {
          const registeredVersion = await this.#registerBackgroundTaskService.call(
            endpoint,
            backgroundTask
          );

          if (registeredVersion) {
            indexStats.backgroundTasks++;
          }
        } catch (error) {
          logger.error("Failed to register background task", {
            endpointId: endpoint.id,
            backgroundTask,
            error,
          });
        }
      }
    }

    const missingBackgroundTasks = existingBackgroundTasks.filter((backgroundTask) => {
      return !backgroundTasks.find((b) => b.id === backgroundTask.slug);
    });

    if (missingBackgroundTasks.length > 0) {
      logger.debug("Disabling missing background tasks", {
        endpointId: endpoint.id,
        missingIds: missingBackgroundTasks.map((job) => job.slug),
      });

      for (const backgroundTask of missingBackgroundTasks) {
        const latestVersion = backgroundTask.aliases[0]?.version;

        if (!latestVersion) {
          continue;
        }

        const disabledBackgroundTask = await this.#disableBackgroundTaskService
          .call(endpoint, {
            slug: backgroundTask.slug,
            version: latestVersion.version,
          })
          .catch((error) => {
            logger.error("Failed to disable background task", {
              endpointId: endpoint.id,
              backgroundTask,
              error,
            });

            return;
          });

        if (disabledBackgroundTask) {
          indexStats.disabledJobs++;
        }
      }
    }

    for (const source of sources) {
      try {
        switch (source.version) {
          default:
          case "1": {
            await this.#registerSourceServiceV1.call(endpoint, source);
            break;
          }
          case "2": {
            await this.#registerSourceServiceV2.call(endpoint, source);
            break;
          }
        }

        indexStats.sources++;
      } catch (error) {
        logger.error("Failed to register source", {
          endpointId: endpoint.id,
          source,
          error,
        });
      }
    }

    for (const dynamicTrigger of dynamicTriggers) {
      try {
        await this.#registerDynamicTriggerService.call(endpoint, dynamicTrigger);

        indexStats.dynamicTriggers++;
      } catch (error) {
        logger.error("Failed to register dynamic trigger", {
          endpointId: endpoint.id,
          dynamicTrigger,
          error,
        });
      }
    }

    for (const dynamicSchedule of dynamicSchedules) {
      try {
        await this.#registerDynamicScheduleService.call(endpoint, dynamicSchedule);

        indexStats.dynamicSchedules++;
      } catch (error) {
        logger.error("Failed to register dynamic schedule", {
          endpointId: endpoint.id,
          dynamicSchedule,
          error,
        });
      }
    }

    logger.debug("Endpoint indexing complete", {
      endpointId: endpoint.id,
      indexStats,
      source,
      sourceData,
      reason,
    });

    return await this.#prismaClient.endpointIndex.create({
      data: {
        endpointId: endpoint.id,
        stats: indexStats,
        data: {
          jobs,
          sources,
          dynamicTriggers,
          dynamicSchedules,
        },
        source,
        sourceData,
        reason,
      },
    });
  }
}
