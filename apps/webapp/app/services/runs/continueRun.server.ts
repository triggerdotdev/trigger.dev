import { $transaction, Prisma, PrismaClient, prisma } from "~/db.server";
import { enqueueRunExecutionV2 } from "~/models/jobRunExecution.server";

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
        });

        if (!RESUMABLE_STATUSES.includes(run.status)) {
          throw new Error("Run is not resumable");
        }

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

        await enqueueRunExecutionV2(run, tx);
      },
      { timeout: 10000 }
    );
  }
}
