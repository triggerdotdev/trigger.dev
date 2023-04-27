import { APIConnection, JobConnection } from ".prisma/client";
import { ApiEventLogSchema, ConnectionAuth } from "@trigger.dev/internal";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { getConnectionAuths } from "../connectionAuth.server";
import { ClientApi, ClientApiError } from "../clientApi.server";
import { workerQueue } from "../worker.server";
import { logger } from "../logger";

export class StartRunService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(id: string) {
    const run = await this.#prismaClient.jobRun.findUniqueOrThrow({
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
    const connections = run.jobInstance.connections.filter(
      (c) => c.apiConnection != null || c.usesLocalAuth
    ) as Array<JobConnection & { apiConnection?: APIConnection }>;

    const client = new ClientApi(
      run.environment.apiKey,
      run.jobInstance.endpoint.url
    );

    const startedAt = run.startedAt ?? new Date();

    await this.#prismaClient.jobRun.update({
      where: { id },
      data: {
        startedAt,
        status: "STARTED",
      },
    });

    const event = ApiEventLogSchema.parse(run.eventLog);

    try {
      const results = await client.executeJob({
        event,
        job: {
          id: run.jobInstance.job.slug,
          version: run.jobInstance.version,
        },
        context: {
          id: run.id,
          environment: run.environment.slug,
          organization: run.organization.slug,
          isTest: run.isTest,
          version: run.jobInstance.version,
          startedAt,
        },
        connections: await getConnectionAuths(connections),
      });

      if (results.completed) {
        await this.#prismaClient.jobRun.update({
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
        await this.#prismaClient.jobRun.update({
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
