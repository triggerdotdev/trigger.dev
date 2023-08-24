import { PrismaClient, prisma } from "~/db.server";
import { logger } from "../logger.server";
import { workerQueue } from "../worker.server";
import { RuntimeEnvironmentType } from "@trigger.dev/database";

export class RecurringEndpointIndexService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(ts: Date) {
    // Find all production endpoints that haven't been indexed in the last 10 minutes
    const currentTimestamp = ts.getTime();

    const endpoints = await this.#prismaClient.endpoint.findMany({
      where: {
        environment: {
          type: RuntimeEnvironmentType.PRODUCTION,
        },

        indexings: {
          none: {
            createdAt: {
              gt: new Date(currentTimestamp - 10 * 60 * 1000),
            },
          },
        },
      },
      include: {
        environment: true,
      },
    });

    logger.debug("Found endpoints that haven't been indexed in the last 10 minutes", {
      count: endpoints.length,
    });

    // Enqueue each endpoint for indexing
    for (const endpoint of endpoints) {
      await workerQueue.enqueue(
        "indexEndpoint",
        {
          id: endpoint.id,
          source: "INTERNAL",
        },
        {
          maxAttempts:
            endpoint.environment.type === RuntimeEnvironmentType.DEVELOPMENT ? 1 : undefined,
        }
      );
    }
  }
}
