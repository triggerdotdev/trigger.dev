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
import { EndpointIndexError } from "@trigger.dev/core";
import { safeBodyFromResponse } from "~/utils/json";
import { fromZodError } from "zod-validation-error";
import { IndexEndpointStats } from "@trigger.dev/core";

export class PerformEndpointIndexService {
  #prismaClient: PrismaClient;
  #registerJobService = new RegisterJobService();
  #disableJobService = new DisableJobService();
  #registerSourceServiceV1 = new RegisterSourceServiceV1();
  #registerSourceServiceV2 = new RegisterSourceServiceV2();
  #registerDynamicTriggerService = new RegisterDynamicTriggerService();
  #registerDynamicScheduleService = new RegisterDynamicScheduleService();

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(id: string) {
    const endpointIndex = await this.#prismaClient.endpointIndex.update({
      where: {
        id,
      },
      data: {
        status: "STARTED",
      },
      include: {
        endpoint: {
          include: {
            environment: {
              include: {
                organization: true,
                project: true,
              },
            },
          },
        },
      },
    });

    logger.debug("Performing endpoint index", endpointIndex);

    // Make a request to the endpoint to fetch a list of jobs
    const client = new EndpointApi(
      endpointIndex.endpoint.environment.apiKey,
      endpointIndex.endpoint.url
    );
    const { response, parser, headerParser, errorParser } = await client.indexEndpoint();

    if (!response) {
      return updateEndpointIndexWithError(this.#prismaClient, id, {
        message: `Could not connect to endpoint ${endpointIndex.endpoint.url}`,
      });
    }

    if (response.status === 401) {
      const body = await safeBodyFromResponse(response, errorParser);

      if (body) {
        return updateEndpointIndexWithError(this.#prismaClient, id, {
          message: body.message,
        });
      }

      return updateEndpointIndexWithError(this.#prismaClient, id, {
        message: "Trigger API key is invalid",
      });
    }

    if (!response.ok) {
      return updateEndpointIndexWithError(this.#prismaClient, id, {
        message: `Could not connect to endpoint ${endpointIndex.endpoint.url}. Status code: ${response.status}`,
      });
    }

    const anyBody = await response.json();
    const bodyResult = parser.safeParse(anyBody);

    if (!bodyResult.success) {
      const issues: string[] = [];
      bodyResult.error.issues.forEach((issue) => {
        if (issue.path.at(0) === "jobs") {
          const jobIndex = issue.path.at(1) as number;
          const job = (anyBody as any).jobs[jobIndex];

          if (job) {
            issues.push(`Job "${job.id}": ${issue.message} at "${issue.path.slice(2).join(".")}".`);
          }
        }
      });

      let friendlyError: string | undefined;
      if (issues.length > 0) {
        friendlyError = `Your Jobs have issues:\n${issues.map((issue) => `- ${issue}`).join("\n")}`;
      } else {
        friendlyError = fromZodError(bodyResult.error, {
          prefix: "There's an issue with the format of your Jobs",
        }).message;
      }

      return updateEndpointIndexWithError(this.#prismaClient, id, {
        message: friendlyError,
        raw: bodyResult.error.issues,
      });
    }

    const headerResult = headerParser.safeParse(Object.fromEntries(response.headers.entries()));
    if (!headerResult.success) {
      const friendlyError = fromZodError(headerResult.error, {
        prefix: "Your headers are invalid",
      });
      return updateEndpointIndexWithError(this.#prismaClient, id, {
        message: friendlyError.message,
        raw: headerResult.error.issues,
      });
    }

    const { jobs, sources, dynamicTriggers, dynamicSchedules } = bodyResult.data;
    const { "trigger-version": triggerVersion } = headerResult.data;
    const { endpoint } = endpointIndex;

    if (triggerVersion && triggerVersion !== endpoint.version) {
      await this.#prismaClient.endpoint.update({
        where: {
          id: endpoint.id,
        },
        data: {
          version: triggerVersion,
        },
      });
    }

    const indexStats: IndexEndpointStats = {
      jobs: 0,
      sources: 0,
      dynamicTriggers: 0,
      dynamicSchedules: 0,
      disabledJobs: 0,
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
            if (!job.internal) {
              indexStats.jobs++;
            }
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
      source: endpointIndex.source,
      sourceData: endpointIndex.sourceData,
      reason: endpointIndex.reason,
    });

    return await this.#prismaClient.endpointIndex.update({
      where: {
        id,
      },
      data: {
        status: "SUCCESS",
        stats: indexStats,
        data: {
          jobs,
          sources,
          dynamicTriggers,
          dynamicSchedules,
        },
      },
    });
  }
}

async function updateEndpointIndexWithError(
  prismaClient: PrismaClient,
  id: string,
  error: EndpointIndexError
) {
  return await prismaClient.endpointIndex.update({
    where: {
      id,
    },
    data: {
      status: "FAILURE",
      error,
    },
  });
}
