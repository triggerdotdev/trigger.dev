import { EXECUTE_JOB_RETRY_LIMIT } from "~/consts";
import { $transaction, Prisma, PrismaClient, prisma } from "~/db.server";
import { workerQueue } from "../worker.server";

const RESUMABLE_STATUSES = ["FAILURE", "TIMED_OUT", "ABORTED", "CANCELED"];

export class ContinueRunService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({ runId }: { runId: string }) {
    return await $transaction(
      this.#prismaClient,
      async (tx) => {
        const run = await tx.jobRun.findUniqueOrThrow({
          where: { id: runId },
          include: {
            queue: true,
          },
        });

        if (!RESUMABLE_STATUSES.includes(run.status)) {
          throw new Error("Run is not resumable");
        }

        if (run.queue.jobCount >= run.queue.maxJobs) {
          await tx.jobRun.update({
            where: { id: runId },
            data: {
              status: "QUEUED",
              queuedAt: new Date(),
              startedAt: null,
              completedAt: null,
              output: Prisma.DbNull,
              timedOutAt: null,
              timedOutReason: null,
            },
          });
        } else {
          await tx.jobRun.update({
            where: { id: runId },
            data: {
              status: "STARTED",
              queuedAt: null,
              startedAt: new Date(),
              completedAt: null,
              output: Prisma.DbNull,
              timedOutAt: null,
              timedOutReason: null,
              queue: {
                update: {
                  jobCount: {
                    increment: 1,
                  },
                },
              },
            },
          });

          const execution = await tx.jobRunExecution.create({
            data: {
              run: {
                connect: {
                  id: runId,
                },
              },
              status: "PENDING",
              reason: "EXECUTE_JOB",
              retryLimit: EXECUTE_JOB_RETRY_LIMIT,
              isRetry: true,
            },
          });

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
      },
      { timeout: 10000 }
    );
  }
}
