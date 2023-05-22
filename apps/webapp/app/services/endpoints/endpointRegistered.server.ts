import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { ClientApi } from "../clientApi.server";
import { workerQueue } from "../worker.server";

export class EndpointRegisteredService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(id: string) {
    const endpoint = await this.#prismaClient.endpoint.findUniqueOrThrow({
      where: {
        id,
      },
      include: {
        environment: true,
      },
    });

    // Make a request to the endpoint to fetch a list of jobs
    const client = new ClientApi(endpoint.environment.apiKey, endpoint.url);

    const { jobs, sources, dynamicTriggers, schedules } =
      await client.getEndpointData();

    const queueName = `endpoint-${endpoint.id}`;

    for (const job of jobs) {
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

    for (const schedule of schedules) {
      await workerQueue.enqueue(
        "registerSchedule",
        {
          schedule,
          endpointId: endpoint.id,
        },
        {
          queueName,
        }
      );
    }
  }
}
