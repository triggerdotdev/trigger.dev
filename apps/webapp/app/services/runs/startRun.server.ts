import { ApiEventLogSchema } from "@trigger.dev/internal";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { resolveRunConnections } from "~/models/runConnection.server";
import { ClientApi, ClientApiError } from "../clientApi.server";
import { workerQueue } from "../worker.server";
import { logger } from "../logger";
import type { ApiConnection, ApiConnectionType } from ".prisma/client";

const RUN_INCLUDES = {
  queue: true,
  event: true,
  externalAccount: true,
  version: {
    include: {
      endpoint: true,
      job: true,
      environment: true,
      organization: true,
      integrations: {
        include: {
          apiConnectionClient: true,
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

        const startableStatuses = [
          "PENDING",
          "QUEUED",
          "WAITING_ON_CONNECTIONS",
        ] as const;

        if (!startableStatuses.includes(run.status)) {
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
          const runConnectionsByKey = await run.version.integrations.reduce(
            async (
              accP: Promise<
                Record<
                  string,
                  | { result: "resolved"; connection: ApiConnection }
                  | {
                      result: "missing";
                      connectionType: ApiConnectionType;
                      apiConnectionClientId: string;
                      externalAccountId?: string;
                    }
                >
              >,
              integration
            ) => {
              const acc = await accP;

              const connection = run.externalAccountId
                ? await tx.apiConnection.findFirst({
                    where: {
                      clientId: integration.apiConnectionClient.id,
                      connectionType: "EXTERNAL",
                      externalAccountId: run.externalAccountId,
                    },
                  })
                : await tx.apiConnection.findFirst({
                    where: {
                      clientId: integration.apiConnectionClient.id,
                      connectionType: "DEVELOPER",
                    },
                  });

              if (connection) {
                acc[integration.key] = { result: "resolved", connection };
              } else {
                acc[integration.key] = {
                  result: "missing",
                  connectionType: run.externalAccountId
                    ? "EXTERNAL"
                    : "DEVELOPER",
                  externalAccountId: run.externalAccountId ?? undefined,
                  apiConnectionClientId: integration.apiConnectionClient.id,
                };
              }

              return acc;
            },
            Promise.resolve({})
          );

          // Make sure we have all the connections we need
          if (
            Object.values(runConnectionsByKey).some(
              (connection) => connection.result === "missing"
            )
          ) {
            // Create missing connections and update the jobRun to be WAITING_ON_CONNECTIONS
            const missingConnections = Object.values(runConnectionsByKey)
              .map((runConnection) =>
                runConnection.result === "missing" ? runConnection : undefined
              )
              .filter(Boolean);

            // Start the jobRun and increment the jobCount
            // TODO: what happens when there are more than 1 missing connection on a run?
            const updatedRun = await tx.jobRun.update({
              where: { id },
              data: {
                status: "WAITING_ON_CONNECTIONS",
                missingConnections: {
                  connectOrCreate: missingConnections.map((connection) => ({
                    where: {
                      apiConnectionClientId_connectionType_externalAccountId: {
                        apiConnectionClientId: connection.apiConnectionClientId,
                        connectionType: connection.connectionType,
                        externalAccountId:
                          connection.externalAccountId ?? "DEVELOPER",
                      },
                    },
                    create: {
                      apiConnectionClientId: connection.apiConnectionClientId,
                      connectionType: connection.connectionType,
                      externalAccountId:
                        connection.externalAccountId ?? "DEVELOPER",
                      resolved: false,
                    },
                  })),
                },
              },
              include: {
                missingConnections: {
                  include: {
                    _count: {
                      select: { runs: true },
                    },
                  },
                },
                ...RUN_INCLUDES,
              },
            });

            for (const missingConnection of updatedRun.missingConnections) {
              if (missingConnection._count.runs === 1) {
                workerQueue.enqueue(
                  "missingConnectionCreated",
                  {
                    id: missingConnection.id,
                  },
                  { tx }
                );
              }
            }

            return { run: updatedRun };
          }

          const createRunConnections = Object.entries(runConnectionsByKey)
            .map(([key, runConnection]) =>
              runConnection.result === "resolved"
                ? {
                    key,
                    apiConnectionId: runConnection.connection.id,
                  }
                : undefined
            )
            .filter(Boolean);

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
                create: createRunConnections,
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

    if (run.status === "WAITING_ON_CONNECTIONS") {
      logger.debug(`Run ${id} waiting on connections, aborting start run`, {
        id,
      });

      return;
    }

    await workerQueue.enqueue("startQueuedRuns", {
      id: run.queueId,
    });

    const startedAt = run.startedAt ?? new Date();

    const event = ApiEventLogSchema.parse({
      ...run.event,
      id: run.event.eventId,
    });

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
        account: run.externalAccount
          ? {
              id: run.externalAccount.identifier,
              metadata: run.externalAccount.metadata,
            }
          : undefined,
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
