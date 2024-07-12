import { type JobRun, RuntimeEnvironmentType } from "@trigger.dev/database";
import { type PrismaClient, type PrismaClientOrTransaction, prisma } from "~/db.server";
import { workerQueue } from "../worker.server";
import { PerformRunExecutionV3Service, type RunExecutionPriority } from "./performRunExecutionV3.server";

type FoundRun = NonNullable<Awaited<ReturnType<typeof findRun>>>;

export class ResumeRunService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(id: string) {
    const run = await findRun(this.#prismaClient, id);

    if (!run) {
      return;
    }

    switch (run.status) {
      case "ABORTED":
      case "CANCELED":
      case "FAILURE":
      case "INVALID_PAYLOAD":
      case "SUCCESS":
      case "TIMED_OUT":
      case "UNRESOLVED_AUTH": {
        return;
      }
      case "QUEUED": {
        await this.#resumeQueuedRun(run);
        break;
      }
      case "WAITING_TO_EXECUTE": {
        await this.#executeRun(run, "resume");
        break;
      }
      case "WAITING_TO_CONTINUE": {
        await this.#resumeWaitingToContinueRun(run);
        break;
      }
      case "STARTED": {
        await this.#resumeStartedRun(run);
        break;
      }
      case "PENDING":
      case "PREPROCESSING": {
        await this.#resumePendingRun(run);
        break;
      }
      case "EXECUTING": {
        throw new Error("Cannot resume a run that is currently executing");
      }
      case "WAITING_ON_CONNECTIONS": {
        throw new Error("Cannot resume a run that is waiting on connections");
      }
      default: {
        const _exhaustiveCheck: never = run.status;
        throw new Error(`Non-exhaustive match for value: ${run.status}`);
      }
    }
  }

  async #resumeQueuedRun(run: FoundRun) {
    await this.#prismaClient.jobRun.update({
      where: {
        id: run.id,
      },
      data: {
        startedAt: run.startedAt ?? new Date(),
      },
    });

    await this.#executeRun(run, "initial");
  }

  async #resumeStartedRun(run: FoundRun) {
    await this.#prismaClient.jobRun.update({
      where: {
        id: run.id,
      },
      data: {
        status: "WAITING_TO_EXECUTE",
      },
    });

    await this.#executeRun(run, "initial");
  }

  async #resumeWaitingToContinueRun(run: FoundRun) {
    await this.#prismaClient.jobRun.update({
      where: {
        id: run.id,
      },
      data: {
        status: "WAITING_TO_EXECUTE",
      },
    });

    await this.#executeRun(run, "resume");
  }

  async #resumePendingRun(run: FoundRun) {
    await this.#prismaClient.jobRun.update({
      where: {
        id: run.id,
      },
      data: {
        status: "QUEUED",
        startedAt: new Date(),
      },
    });

    await this.#executeRun(run, "initial");
  }

  async #executeRun(run: FoundRun, priority: RunExecutionPriority) {
    await PerformRunExecutionV3Service.enqueue(run, priority, this.#prismaClient, {
      skipRetrying: run.version.environment.type === RuntimeEnvironmentType.DEVELOPMENT,
    });
  }

  static async enqueue(run: JobRun, tx: PrismaClientOrTransaction, runAt?: Date) {
    return await workerQueue.enqueue(
      "resumeRun",
      {
        id: run.id,
      },
      {
        tx,
        runAt: runAt ?? run.createdAt,
        jobKey: `run_resume:${run.id}`,
      }
    );
  }

  static async dequeue(run: JobRun, tx: PrismaClientOrTransaction) {
    await workerQueue.dequeue(`run_resume:${run.id}`, {
      tx,
    });
  }
}

async function findRun(prisma: PrismaClientOrTransaction, id: string) {
  return await prisma.jobRun.findUnique({
    where: { id },
    include: {
      job: true,
      version: {
        include: {
          environment: {
            include: {
              organization: true,
              project: true,
            },
          },
          concurrencyLimitGroup: true,
        },
      },
    },
  });
}
