import { ApiEventLogSchema } from "@trigger.dev/internal";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { resolveRunConnections } from "~/models/runConnection.server";
import { ClientApi, ClientApiError } from "../clientApi.server";
import { workerQueue } from "../worker.server";
import { logger } from "../logger";
import type { ApiConnection } from ".prisma/client";

const RUN_INCLUDES = {
  queue: true,
  event: true,
  version: {
    include: {
      endpoint: true,
      job: true,
      environment: true,
      organization: true,
      integrations: {
        include: {
          apiConnectionClient: {
            include: {
              connections: {
                where: {
                  connectionType: "DEVELOPER",
                },
              },
            },
          },
        },
      },
    },
  },
} as const;

export class StartRunService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(id: string) {
    const transactionResults = await this.#prismaClient.$transaction(
      async (tx) => {
        const run = await tx.jobRun.findUnique({
          where: { id },
          include: RUN_INCLUDES,
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
          const updatedRun = await tx.jobRun.update({
            where: { id },
            data: {
              status: "QUEUED",
              queuedAt: new Date(),
            },
            include: RUN_INCLUDES,
          });

          return { run: updatedRun };
        } else {
          // If any of the connections are missing, we can't start the execution
          const runConnectionsByKey = run.version.integrations.reduce(
            (acc: Record<string, ApiConnection>, connection) => {
              if (connection.apiConnectionClient.connections.length === 0) {
                return acc;
              }

              acc[connection.key] =
                connection.apiConnectionClient.connections[0];

              return acc;
            },
            {}
          );

          // Start the jobRun and increment the jobCount
          const updatedRun = await tx.jobRun.update({
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
              runConnections: {
                create: Object.entries(runConnectionsByKey).map(
                  ([key, connection]) => ({
                    key,
                    apiConnectionId: connection.id,
                  })
                ),
              },
            },
            include: {
              runConnections: {
                include: {
                  apiConnection: {
                    include: {
                      dataReference: true,
                    },
                  },
                },
              },
              ...RUN_INCLUDES,
            },
          });

          const connections = await resolveRunConnections(
            updatedRun.runConnections
          );

          if (
            Object.keys(connections).length < updatedRun.runConnections.length
          ) {
            throw new Error(
              `Could not resolve all connections for run ${
                run.id
              }, there should be ${
                updatedRun.runConnections.length
              } connections but only ${
                Object.keys(connections).length
              } were resolved.`
            );
          }

          return { run: updatedRun, connections };
        }
      }
    );

    if (!transactionResults) {
      logger.debug(`Run ${id} not found, aborting start run`, { id });

      return;
    }

    const { run, connections } = transactionResults;

    if (run.status === "QUEUED") {
      logger.debug(`Run ${id} queued, aborting start run`, { id });

      return;
    }

    await workerQueue.enqueue("startQueuedRuns", {
      id: run.queueId,
    });

    const startedAt = run.startedAt ?? new Date();

    const event = ApiEventLogSchema.parse(run.event);

    const client = new ClientApi(
      run.version.environment.apiKey,
      run.version.endpoint.url
    );

    try {
      // TODO: update this to implement retrying
      const results = await client.executeJob({
        event,
        job: {
          id: run.version.job.slug,
          version: run.version.version,
        },
        run: {
          id: run.id,
          isTest: run.isTest,
          startedAt,
        },
        environment: {
          id: run.version.environment.id,
          slug: run.version.environment.slug,
          type: run.version.environment.type,
        },
        organization: {
          id: run.version.organization.id,
          slug: run.version.organization.slug,
          title: run.version.organization.title,
        },
        connections,
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

        await workerQueue.enqueue("runFinished", {
          id: run.id,
        });

        return;
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

      await workerQueue.enqueue("runFinished", {
        id: run.id,
      });
    }
  }
}
