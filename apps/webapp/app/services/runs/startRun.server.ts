import type {
  ConnectionType,
  Integration,
  IntegrationConnection,
} from "@trigger.dev/database";
import { EXECUTE_JOB_RETRY_LIMIT, PREPROCESS_RETRY_LIMIT } from "~/consts";
import type { PrismaClient, PrismaClientOrTransaction } from "~/db.server";
import { prisma } from "~/db.server";
import { workerQueue } from "../worker.server";

type FoundRun = NonNullable<Awaited<ReturnType<typeof findRun>>>;
type RunConnectionsByKey = Awaited<ReturnType<typeof createRunConnections>>;

export class StartRunService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(id: string) {
    const run = await findRun(this.#prismaClient, id);

    if (!run || !this.#runIsStartable(run)) {
      return;
    }

    if (run.queue.jobCount >= run.queue.maxJobs) {
      await this.#queueRun(id);
    } else {
      const runConnectionsByKey = await createRunConnections(this.#prismaClient, run);

      if (hasMissingConnections(runConnectionsByKey)) {
        await this.#handleMissingConnections(id, runConnectionsByKey);
      } else {
        await this.#startRun(id, run, runConnectionsByKey);
      }
    }
  }

  #runIsStartable(run: FoundRun) {
    const startableStatuses = [
      "PENDING",
      "QUEUED",
      "WAITING_ON_CONNECTIONS",
    ] as const;
    return startableStatuses.includes(run.status);
  }

  async #queueRun(id: string) {
    await this.#prismaClient.jobRun.update({
      where: { id },
      data: {
        status: "QUEUED",
        queuedAt: new Date(),
      },
    });
  }

  async #startRun(
    id: string,
    run: FoundRun,
    runConnectionsByKey: RunConnectionsByKey
  ) {
    const createRunConnections = Object.entries(runConnectionsByKey)
      .map(([key, runConnection]) =>
        runConnection.result === "resolvedHosted"
          ? ({
              key,
              connectionId: runConnection.connection.id,
              integrationId: runConnection.integration.id,
              authSource: "HOSTED",
            } as const)
          : runConnection.result === "resolvedLocal"
          ? ({
              key,
              integrationId: runConnection.integration.id,
              authSource: "LOCAL",
            } as const)
          : undefined
      )
      .filter(Boolean);

    const updateRunAndCreateExecution = async () => {
      if (run.preprocess) {
        // Start the jobRun and increment the jobCount
        await this.#prismaClient.jobRun.update({
          where: { id },
          data: {
            status: "PREPROCESSING",
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
        });

        return await this.#prismaClient.jobRunExecution.create({
          data: {
            run: {
              connect: {
                id,
              },
            },
            status: "PENDING",
            reason: "PREPROCESS",
            retryLimit: PREPROCESS_RETRY_LIMIT,
          },
        });
      } else {
        // Start the jobRun and increment the jobCount
        await this.#prismaClient.jobRun.update({
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
        });

        return await this.#prismaClient.jobRunExecution.create({
          data: {
            run: {
              connect: {
                id,
              },
            },
            status: "PENDING",
            reason: "EXECUTE_JOB",
            retryLimit: EXECUTE_JOB_RETRY_LIMIT,
          },
        });
      }
    };

    const execution = await updateRunAndCreateExecution();

    const job = await workerQueue.enqueue(
      "performRunExecution",
      {
        id: execution.id,
      },
    );

    await this.#prismaClient.jobRunExecution.update({
      where: { id: execution.id },
      data: {
        graphileJobId: job.id,
      },
    });

    await workerQueue.enqueue(
      "startQueuedRuns",
      {
        id: run.queueId,
      },
    );
  }

  async #handleMissingConnections(
    id: string,
    runConnectionsByKey: RunConnectionsByKey
  ) {
    const missingConnections = Object.values(runConnectionsByKey)
      .map((runConnection) =>
        runConnection.result === "missing" ? runConnection : undefined
      )
      .filter(Boolean);

    const updatedRun = await this.#prismaClient.jobRun.update({
      where: { id },
      data: {
        status: "WAITING_ON_CONNECTIONS",
        missingConnections: {
          connectOrCreate: missingConnections.map((connection) => ({
            where: {
              integrationId_connectionType_accountIdentifier: {
                integrationId: connection.integration.id,
                connectionType: connection.connectionType,
                accountIdentifier: connection.externalAccountId ?? "DEVELOPER",
              },
            },
            create: {
              integrationId: connection.integration.id,
              connectionType: connection.connectionType,
              accountIdentifier: connection.externalAccountId ?? "DEVELOPER",
              externalAccountId: connection.externalAccountId,
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
      },
    });

    for (const missingConnection of updatedRun.missingConnections) {
      if (missingConnection._count.runs === 1) {
        workerQueue.enqueue(
          "missingConnectionCreated",
          {
            id: missingConnection.id,
          },
        );
      }
    }
  }
}

async function findRun(tx: PrismaClientOrTransaction, id: string) {
  return await tx.jobRun.findUnique({
    where: { id },
    include: {
      queue: true,
      version: {
        include: {
          integrations: {
            include: {
              integration: true,
            },
          },
        },
      },
    },
  });
}

async function createRunConnections(
  tx: PrismaClientOrTransaction,
  run: FoundRun
) {
  return await run.version.integrations.reduce(
    async (
      accP: Promise<
        Record<
          string,
          | {
              result: "resolvedHosted";
              connection: IntegrationConnection;
              integration: Integration;
            }
          | { result: "resolvedLocal"; integration: Integration }
          | {
              result: "missing";
              connectionType: ConnectionType;
              integration: Integration;
              externalAccountId?: string;
            }
        >
      >,
      jobIntegration
    ) => {
      const acc = await accP;

      if (jobIntegration.integration.authSource === "LOCAL") {
        acc[jobIntegration.key] = {
          result: "resolvedLocal",
          integration: jobIntegration.integration,
        };
      } else {
        const connection = run.externalAccountId
          ? await tx.integrationConnection.findFirst({
              where: {
                integrationId: jobIntegration.integration.id,
                connectionType: "EXTERNAL",
                externalAccountId: run.externalAccountId,
              },
            })
          : await tx.integrationConnection.findFirst({
              where: {
                integrationId: jobIntegration.integration.id,
                connectionType: "DEVELOPER",
              },
            });

        if (connection) {
          acc[jobIntegration.key] = {
            result: "resolvedHosted",
            connection,
            integration: jobIntegration.integration,
          };
        } else {
          acc[jobIntegration.key] = {
            result: "missing",
            connectionType: run.externalAccountId ? "EXTERNAL" : "DEVELOPER",
            externalAccountId: run.externalAccountId ?? undefined,
            integration: jobIntegration.integration,
          };
        }
      }

      return acc;
    },
    Promise.resolve({})
  );
}

function hasMissingConnections(runConnectionsByKey: RunConnectionsByKey) {
  return Object.values(runConnectionsByKey).some(
    (connection) => connection.result === "missing"
  );
}
