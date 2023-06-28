import { $transaction, PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { EndpointApi } from "../endpointApi.server";
import { workerQueue } from "../worker.server";
import type { EndpointIndexSource } from "@trigger.dev/database";

export class IndexEndpointService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(
    id: string,
    source: EndpointIndexSource = "INTERNAL",
    reason?: string,
    sourceData?: any
  ) {
    const endpoint = await this.#prismaClient.endpoint.findUniqueOrThrow({
      where: {
        id,
      },
      include: {
        environment: true,
      },
    });

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

    const queueName = `endpoint-${endpoint.id}`;

    const indexStats = {
      jobs: 0,
      sources: 0,
      dynamicTriggers: 0,
      dynamicSchedules: 0,
    };

    return await $transaction(this.#prismaClient, async (tx) => {
      for (const job of jobs) {
        if (!job.enabled) {
          continue;
        }

        indexStats.jobs++;

        await workerQueue.enqueue(
          "registerJob",
          {
            job,
            endpointId: endpoint.id,
          },
          {
            queueName,
          }
        );
      }

      for (const source of sources) {
        indexStats.sources++;

        await workerQueue.enqueue(
          "registerSource",
          {
            source,
            endpointId: endpoint.id,
          },
          {
            queueName,
          }
        );
      }

      for (const dynamicTrigger of dynamicTriggers) {
        indexStats.dynamicTriggers++;

        await workerQueue.enqueue(
          "registerDynamicTrigger",
          {
            dynamicTrigger,
            endpointId: endpoint.id,
          },
          {
            queueName,
          }
        );
      }

      for (const dynamicSchedule of dynamicSchedules) {
        indexStats.dynamicSchedules++;

        await workerQueue.enqueue(
          "registerDynamicSchedule",
          {
            dynamicSchedule,
            endpointId: endpoint.id,
          },
          {
            queueName,
          }
        );
      }

      return await tx.endpointIndex.create({
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
    });
  }
}
