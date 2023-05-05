import { ApiEventLogSchema } from "@trigger.dev/internal";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import type { JobConnectionWithApiConnection } from "~/models/jobConnection.server";
import { resolveJobConnections } from "~/models/jobConnection.server";
import { ClientApi, ClientApiError } from "../clientApi.server";
import { workerQueue } from "../worker.server";
import { logger } from "../logger";

export class StartRunService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(id: string) {
    const run = await this.#prismaClient.$transaction(async (tx) => {
      const run = await tx.jobRun.findUnique({
        where: { id },
        include: {
          queue: true,
        },
      });

      if (!run) {
        return;
      }

      if (run.status !== "PENDING" && run.status !== "QUEUED") {
        return;
      }

      // Check the JobQueue to make sure we can start the run
      if (run.queue.jobCount >= run.queue.maxJobs) {
        // Set the run status to QUEUED and return
        return tx.jobRun.update({
          where: { id },
          data: {
            status: "QUEUED",
            queuedAt: new Date(),
          },
          include: {
            eventLog: true,
          },
        });
      } else {
        // Start the jobRun and increment the jobCount
        return tx.jobRun.update({
          where: { id },
          data: {
            status: "STARTED",
            startedAt: new Date(),
            queue: {
              update: {
                jobCount: {
                  increment: 1,
                },
              },
            },
          },
          include: {
            eventLog: true,
          },
        });
      }
    });

    if (!run) {
      logger.debug(`Run ${id} not found, aborting start run`, { id });

      return;
    }

    if (run.status === "QUEUED") {
      logger.debug(`Run ${id} queued, aborting start run`, { id });

      return;
    }

    await workerQueue.enqueue("startQueuedRuns", {
      id: run.queueId,
    });

    const jobInstance = await this.#prismaClient.jobInstance.findUniqueOrThrow({
      where: { id: run.jobInstanceId },
      include: {
        endpoint: true,
        job: true,
        environment: true,
        organization: true,
        connections: {
          include: {
            apiConnection: {
              include: {
                dataReference: true,
              },
            },
          },
        },
      },
    });

    // If any of the connections are missing, we can't start the execution
    const connections: Array<JobConnectionWithApiConnection> =
      jobInstance.connections.filter(
        (c) => c.apiConnection != null || c.usesLocalAuth
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

    const client = new ClientApi(
      jobInstance.environment.apiKey,
      jobInstance.endpoint.url
    );

    try {
      const results = await client.executeJob({
        event,
        job: {
          id: jobInstance.job.slug,
          version: jobInstance.version,
        },
        context: {
          id: run.id,
          environment: jobInstance.environment.slug,
          organization: jobInstance.organization.slug,
          isTest: run.isTest,
          version: jobInstance.version,
          startedAt,
        },
        connections: await resolveJobConnections(connections),
      });

      if (results.completed) {
        await this.#prismaClient.jobRun.update({
          where: { id },
          data: {
            completedAt: new Date(),
            status: "SUCCESS",
            output: results.output ?? undefined,
            queue: {
              update: {
                jobCount: {
                  decrement: 1,
                },
              },
            },
          },
        });

        await workerQueue.enqueue("startQueuedRuns", {
          id: run.queueId,
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
            queue: {
              update: {
                jobCount: {
                  decrement: 1,
                },
              },
            },
          },
        });
      } else {
        await this.#prismaClient.jobRun.update({
          where: { id },
          data: {
            completedAt: new Date(),
            status: "FAILURE",
            output: {
              message: error instanceof Error ? error.message : "Unknown Error",
              stack: error instanceof Error ? error.stack : undefined,
            },
            queue: {
              update: {
                jobCount: {
                  decrement: 1,
                },
              },
            },
          },
        });
      }

      await workerQueue.enqueue("startQueuedRuns", {
        id: run.queueId,
      });
    }
  }
}
