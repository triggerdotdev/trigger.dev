import { APIConnection, JobConnection } from ".prisma/client";
import { ApiEventLogSchema, ConnectionAuth } from "@trigger.dev/internal";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { getConnectionAuths } from "../connectionAuth.server";
import { ClientApi, ClientApiError } from "../clientApi.server";
import { workerQueue } from "../worker.server";
import { logger } from "../logger";

export class StartExecutionService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(id: string) {
    const execution = await this.#prismaClient.execution.findUniqueOrThrow({
      where: { id },
      include: {
        jobInstance: {
          include: {
            endpoint: true,
            job: true,
            connections: {
              include: {
                apiConnection: true,
              },
              where: {
                key: { not: "__trigger" },
              },
            },
          },
        },
        environment: true,
        eventLog: true,
        organization: true,
      },
    });

    // If any of the connections are missing, we can't start the execution
    const connections = execution.jobInstance.connections.filter(
      (c) => c.apiConnection != null || c.usesLocalAuth
    ) as Array<JobConnection & { apiConnection?: APIConnection }>;

    const client = new ClientApi(
      execution.environment.apiKey,
      execution.jobInstance.endpoint.url
    );

    const startedAt = execution.startedAt ?? new Date();

    await this.#prismaClient.execution.update({
      where: { id },
      data: {
        startedAt,
        status: "STARTED",
      },
    });

    const event = ApiEventLogSchema.parse(execution.eventLog);

    try {
      const results = await client.executeJob({
        event,
        job: {
          id: execution.jobInstance.job.slug,
          version: execution.jobInstance.version,
        },
        context: {
          id: execution.id,
          environment: execution.environment.slug,
          organization: execution.organization.slug,
          isTest: execution.isTest,
          version: execution.jobInstance.version,
          startedAt,
        },
        connections: await getConnectionAuths(connections),
      });

      if (results.completed) {
        await this.#prismaClient.execution.update({
          where: { id },
          data: {
            completedAt: new Date(),
            status: "SUCCESS",
            output: results.output ?? undefined,
          },
        });
      }

      if (results.task) {
        await workerQueue.enqueue(
          "resumeTask",
          {
            id: results.task.id,
          },
          { runAt: results.task.delayUntil ?? undefined }
        );

        return;
      }
    } catch (error) {
      if (error instanceof ClientApiError) {
        await this.#prismaClient.execution.update({
          where: { id },
          data: {
            completedAt: new Date(),
            status: "FAILURE",
            output: { message: error.message, stack: error.stack },
          },
        });
      }
    }
  }
}
