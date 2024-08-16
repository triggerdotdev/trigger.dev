import { PrismaClientOrTransaction } from "~/db.server";
import { workerQueue } from "~/services/worker.server";
import { marqs } from "~/v3/marqs/index.server";
import { BaseService } from "./baseService.server";
import { logger } from "~/services/logger.server";

export class ExecuteTasksWaitingForDeployService extends BaseService {
  public async call(backgroundWorkerId: string) {
    const backgroundWorker = await this._prisma.backgroundWorker.findFirst({
      where: {
        id: backgroundWorkerId,
      },
      include: {
        runtimeEnvironment: {
          include: {
            project: true,
            organization: true,
          },
        },
        tasks: true,
      },
    });

    if (!backgroundWorker) {
      logger.error("Background worker not found", { id: backgroundWorkerId });
      return;
    }

    const runsWaitingForDeploy = await this._prisma.taskRun.findMany({
      where: {
        runtimeEnvironmentId: backgroundWorker.runtimeEnvironmentId,
        projectId: backgroundWorker.projectId,
        status: "WAITING_FOR_DEPLOY",
        taskIdentifier: {
          in: backgroundWorker.tasks.map((task) => task.slug),
        },
      },
      orderBy: {
        number: "asc",
      },
    });

    if (!runsWaitingForDeploy.length) {
      return;
    }

    // Clear any runs awaiting deployment for execution
    const pendingRuns = await this._prisma.taskRun.updateMany({
      where: {
        id: {
          in: runsWaitingForDeploy.map((run) => run.id),
        },
      },
      data: {
        status: "PENDING",
      },
    });

    if (pendingRuns.count) {
      logger.debug("Task runs waiting for deploy are now ready for execution", {
        tasks: runsWaitingForDeploy.map((run) => run.id),
        total: pendingRuns.count,
      });
    }

    if (!marqs) {
      return;
    }

    const enqueues: Promise<any>[] = [];
    let i = 0;

    for (const run of runsWaitingForDeploy) {
      enqueues.push(
        marqs.enqueueMessage(
          backgroundWorker.runtimeEnvironment,
          run.queue,
          run.id,
          {
            type: "EXECUTE",
            taskIdentifier: run.taskIdentifier,
            projectId: backgroundWorker.runtimeEnvironment.projectId,
            environmentId: backgroundWorker.runtimeEnvironment.id,
            environmentType: backgroundWorker.runtimeEnvironment.type,
          },
          run.concurrencyKey ?? undefined,
          Date.now() + i * 5 // slight delay to help preserve order
        )
      );

      i++;
    }

    const settled = await Promise.allSettled(enqueues);

    if (settled.some((s) => s.status === "rejected")) {
      const rejectedRuns: { id: string; reason: any }[] = [];

      runsWaitingForDeploy.forEach((run, i) => {
        if (settled[i].status === "rejected") {
          const rejected = settled[i] as PromiseRejectedResult;

          rejectedRuns.push({ id: run.id, reason: rejected.reason });
        }
      });

      logger.error("Failed to requeue task runs for immediate execution", {
        rejectedRuns,
      });
    }
  }

  static async enqueue(backgroundWorkerId: string, tx: PrismaClientOrTransaction, runAt?: Date) {
    return await workerQueue.enqueue(
      "v3.executeTasksWaitingForDeploy",
      {
        backgroundWorkerId,
      },
      {
        tx,
        runAt,
      }
    );
  }
}
