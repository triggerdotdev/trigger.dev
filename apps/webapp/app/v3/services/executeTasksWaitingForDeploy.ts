import { PrismaClientOrTransaction } from "~/db.server";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { runsDashboard } from "~/services/runsDashboardInstance.server";
import { workerQueue } from "~/services/worker.server";
import { marqs } from "~/v3/marqs/index.server";
import { BaseService } from "./baseService.server";

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
        tasks: {
          select: {
            slug: true,
          },
        },
      },
    });

    if (!backgroundWorker) {
      logger.error("Background worker not found", { id: backgroundWorkerId });
      return;
    }

    const maxCount = env.LEGACY_RUN_ENGINE_WAITING_FOR_DEPLOY_BATCH_SIZE;

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
        createdAt: "asc",
      },
      select: {
        id: true,
        status: true,
        taskIdentifier: true,
        concurrencyKey: true,
        queue: true,
        updatedAt: true,
        createdAt: true,
      },
      take: maxCount + 1,
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

    for (const run of runsWaitingForDeploy) {
      runsDashboard.emit.runStatusChanged({
        time: new Date(),
        run: {
          id: run.id,
          status: run.status,
          updatedAt: run.updatedAt,
          createdAt: run.createdAt,
        },
        organization: {
          id: backgroundWorker.runtimeEnvironment.organizationId,
        },
        project: {
          id: backgroundWorker.runtimeEnvironment.projectId,
        },
        environment: {
          id: backgroundWorker.runtimeEnvironment.id,
        },
      });
    }

    for (const run of runsWaitingForDeploy) {
      await marqs?.enqueueMessage(
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
        run.concurrencyKey ?? undefined
      );
    }

    if (runsWaitingForDeploy.length > maxCount) {
      await ExecuteTasksWaitingForDeployService.enqueue(
        backgroundWorkerId,
        this._prisma,
        new Date(Date.now() + env.LEGACY_RUN_ENGINE_WAITING_FOR_DEPLOY_BATCH_STAGGER_MS)
      );
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
