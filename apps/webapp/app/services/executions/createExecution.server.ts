import type {
  Organization,
  RuntimeEnvironment,
  JobConnection,
} from ".prisma/client";
import type { CreateExecutionBody } from "@trigger.dev/internal";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { APIConnection } from "~/models/apiConnection.server";
import { workerQueue } from "~/services/worker.server";
import { logger } from "../logger";

export class CreateExecutionService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(
    environment: RuntimeEnvironment,
    organization: Organization,
    data: CreateExecutionBody
  ) {
    const endpoint = await this.#prismaClient.endpoint.findUniqueOrThrow({
      where: {
        environmentId_slug: {
          environmentId: environment.id,
          slug: data.client,
        },
      },
    });

    const job = await this.#prismaClient.job.findUniqueOrThrow({
      where: {
        organizationId_slug: {
          organizationId: organization.id,
          slug: data.job.id,
        },
      },
    });

    const jobInstance = await this.#prismaClient.jobInstance.findUniqueOrThrow({
      where: {
        jobId_version_endpointId: {
          jobId: job.id,
          version: data.job.version,
          endpointId: endpoint.id,
        },
      },
      include: {
        connections: {
          include: {
            apiConnection: true,
          },
          where: {
            key: { not: "__trigger" },
          },
        },
      },
    });

    const connections = jobInstance.connections.filter(
      (c) => c.apiConnection != null || c.usesLocalAuth
    ) as Array<JobConnection & { apiConnection?: APIConnection }>;

    if (connections.length !== jobInstance.connections.length) {
      logger.debug(
        "Not all connections are available, not creating an execution",
        {
          connections: jobInstance.connections,
          connectionsWithApi: connections,
        }
      );

      return;
    }

    const execution = await this.#prismaClient.$transaction(async (prisma) => {
      // Get the current max number for the given jobId
      const currentMaxNumber = await prisma.execution.aggregate({
        where: { jobId: job.id },
        _max: { number: true },
      });

      // Increment the number for the new execution
      const newNumber = (currentMaxNumber._max.number ?? 0) + 1;

      // Create the new execution with the incremented number
      return prisma.execution.create({
        data: {
          number: newNumber,
          job: { connect: { id: job.id } },
          jobInstance: { connect: { id: jobInstance.id } },
          eventLog: { connect: { id: data.event.id } },
          environment: { connect: { id: environment.id } },
          organization: { connect: { id: organization.id } },
          endpoint: { connect: { id: endpoint.id } },
        },
      });
    });

    await workerQueue.enqueue("startExecution", {
      id: execution.id,
    });

    return execution;
  }
}
