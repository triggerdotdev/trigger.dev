import type { EndpointIndexSource } from "@trigger.dev/database";
import { PrismaClient, prisma } from "~/db.server";
import { findEndpoint } from "~/models/endpoint.server";
import { EndpointApi } from "../endpointApi.server";
import { RegisterJobService } from "../jobs/registerJob.server";
import { logger } from "../logger.server";
import { RegisterSourceService } from "../sources/registerSource.server";
import { RegisterDynamicScheduleService } from "../triggers/registerDynamicSchedule.server";
import { RegisterDynamicTriggerService } from "../triggers/registerDynamicTrigger.server";

export class IndexEndpointService {
  #prismaClient: PrismaClient;
  #registerJobService = new RegisterJobService();
  #registerSourceService = new RegisterSourceService();
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
    const client = new EndpointApi(
      endpoint.environment.apiKey,
      endpoint.url,
      endpoint.slug
    );

    const indexResponse = await client.indexEndpoint();

    if (!indexResponse.ok) {
      throw new Error(indexResponse.error);
    }

    const { jobs, sources, dynamicTriggers, dynamicSchedules } =
      indexResponse.data;

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
      },
    });

    const indexStats = {
      jobs: 0,
      sources: 0,
      dynamicTriggers: 0,
      dynamicSchedules: 0,
    };

    for (const job of jobs) {
      if (!job.enabled) {
        continue;
      }

      try {
        await this.#registerJobService.call(endpoint, job);

        indexStats.jobs++;
      } catch (error) {
        logger.debug("Failed to register job", {
          endpointId: endpoint.id,
          job,
        });

        logger.error(error);
      }
    }

    for (const source of sources) {
      try {
        await this.#registerSourceService.call(endpoint, source);

        indexStats.sources++;
      } catch (error) {
        logger.debug("Failed to register source", {
          endpointId: endpoint.id,
          source,
        });

        logger.error(error);
      }
    }

    for (const dynamicTrigger of dynamicTriggers) {
      try {
        await this.#registerDynamicTriggerService.call(
          endpoint,
          dynamicTrigger
        );

        indexStats.dynamicTriggers++;
      } catch (error) {
        logger.debug("Failed to register dynamic trigger", {
          endpointId: endpoint.id,
          dynamicTrigger,
        });

        logger.error(error);
      }
    }

    for (const dynamicSchedule of dynamicSchedules) {
      try {
        await this.#registerDynamicScheduleService.call(
          endpoint,
          dynamicSchedule
        );

        indexStats.dynamicSchedules++;
      } catch (error) {
        logger.debug("Failed to register dynamic schedule", {
          endpointId: endpoint.id,
          dynamicSchedule,
        });

        logger.error(error);
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
