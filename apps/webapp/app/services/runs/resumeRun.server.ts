import { JobRun, RuntimeEnvironmentType } from "@trigger.dev/database";
import { PrismaClient, PrismaClientOrTransaction, prisma } from "~/db.server";
import { workerQueue } from "../worker.server";
import { PerformRunExecutionV3Service } from "./performRunExecutionV3.server";

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
        await this.#executeRun(run);
        break;
      }
      case "WAITING_TO_CONTINUE":
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

    await this.#executeRun(run);
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

    await this.#executeRun(run);
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

    await this.#executeRun(run);
  }

  async #executeRun(run: FoundRun) {
    await PerformRunExecutionV3Service.enqueue(run, this.#prismaClient, {
      skipRetrying: run.environment.type === RuntimeEnvironmentType.DEVELOPMENT,
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
        runAt: runAt,
        queueName: `run_resume:${run.id}`,
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
      environment: true,
    },
  });
}
