import type { ApiConnection, ApiConnectionType } from ".prisma/client";
import type { PrismaClient, PrismaClientOrTransaction } from "~/db.server";
import { prisma } from "~/db.server";
import { workerQueue } from "../worker.server";
import { EXECUTE_JOB_RETRY_LIMIT, PREPROCESS_RETRY_LIMIT } from "~/consts";

type FoundRun = NonNullable<Awaited<ReturnType<typeof findRun>>>;
type RunConnectionsByKey = Awaited<ReturnType<typeof createRunConnections>>;

export class StartRunService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(id: string) {
    await this.#prismaClient.$transaction(async (tx) => {
      const run = await findRun(tx, id);

      if (!run || !this.#runIsStartable(run)) {
        return;
      }

      if (run.queue.jobCount >= run.queue.maxJobs) {
        await this.#queueRun(tx, id);
      } else {
        const runConnectionsByKey = await createRunConnections(tx, run);

        if (hasMissingConnections(runConnectionsByKey)) {
          await this.#handleMissingConnections(tx, id, runConnectionsByKey);
        } else {
          await this.#startRun(tx, id, run, runConnectionsByKey);
        }
      }
    });
  }

  #runIsStartable(run: FoundRun) {
    const startableStatuses = [
      "PENDING",
      "QUEUED",
      "WAITING_ON_CONNECTIONS",
    ] as const;
    return startableStatuses.includes(run.status);
  }

  async #queueRun(tx: PrismaClientOrTransaction, id: string) {
    await tx.jobRun.update({
      where: { id },
      data: {
        status: "QUEUED",
        queuedAt: new Date(),
      },
    });
  }

  async #startRun(
    tx: PrismaClientOrTransaction,
    id: string,
    run: FoundRun,
    runConnectionsByKey: RunConnectionsByKey
  ) {
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

    const updateRunAndCreateExecution = async () => {
      if (run.preprocess) {
        // Start the jobRun and increment the jobCount
        await tx.jobRun.update({
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

        return await tx.jobRunExecution.create({
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
        await tx.jobRun.update({
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

        return await tx.jobRunExecution.create({
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
      { tx }
    );

    await tx.jobRunExecution.update({
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
      { tx }
    );
  }

  async #handleMissingConnections(
    tx: PrismaClientOrTransaction,
    id: string,
    runConnectionsByKey: RunConnectionsByKey
  ) {
    const missingConnections = Object.values(runConnectionsByKey)
      .map((runConnection) =>
        runConnection.result === "missing" ? runConnection : undefined
      )
      .filter(Boolean);

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
                externalAccountId: connection.externalAccountId ?? "DEVELOPER",
              },
            },
            create: {
              apiConnectionClientId: connection.apiConnectionClientId,
              connectionType: connection.connectionType,
              externalAccountId: connection.externalAccountId ?? "DEVELOPER",
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
          { tx }
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
              apiConnectionClient: true,
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
          connectionType: run.externalAccountId ? "EXTERNAL" : "DEVELOPER",
          externalAccountId: run.externalAccountId ?? undefined,
          apiConnectionClientId: integration.apiConnectionClient.id,
        };
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
