import { ownerEngine } from "@trigger.dev/core/v3/isomorphic";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { marqs } from "~/v3/marqs/index.server";
import { commonWorker } from "../commonWorker.server";
import { BaseService } from "./baseService.server";

export class ExecuteTasksWaitingForDeployService extends BaseService {
  public async call(backgroundWorkerId: string) {
    // Kill-switch for the legacy V1 WAITING_FOR_DEPLOY drain. Set to "1" to
    // neuter any jobs already enqueued (V2 has its own PENDING_VERSION path).
    if (env.LEGACY_RUN_ENGINE_WAITING_FOR_DEPLOY_DISABLED === "1") {
      return;
    }

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

    const runsWaitingForDeploy = await this.runStore.findRuns(
      {
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
      },
      this._replica
    );

    if (!runsWaitingForDeploy.length) {
      return;
    }

    // Defense-in-depth: the open-predicate findRuns fan-out can select runs from
    // either DB, but the status flip below is a single control-plane updateMany. A
    // run-ops id (NEW-resident) run can only reach WAITING_FOR_DEPLOY via a misconfiguration
    // (it is a V1/cuid-only status — V2 uses PENDING_VERSION). Surface it loudly rather
    // than silently strand the run, and only mutate the LEGACY-resident runs the
    // control-plane client can actually reach.
    const newResidentRuns = runsWaitingForDeploy.filter((run) => ownerEngine(run.id) === "NEW");
    if (newResidentRuns.length) {
      logger.error(
        "WAITING_FOR_DEPLOY selected NEW-resident runs; skipping their control-plane status flip",
        { runIds: newResidentRuns.map((run) => run.id) }
      );
    }
    const legacyRuns = runsWaitingForDeploy.filter((run) => !newResidentRuns.includes(run));

    const pendingRuns = await this._prisma.taskRun.updateMany({
      where: {
        id: {
          in: legacyRuns.map((run) => run.id),
        },
      },
      data: {
        status: "PENDING",
      },
    });

    if (pendingRuns.count) {
      logger.debug("Task runs waiting for deploy are now ready for execution", {
        tasks: legacyRuns.map((run) => run.id),
        total: pendingRuns.count,
      });
    }

    // Only enqueue the runs whose status was actually flipped (the legacy set) — never
    // marqs-enqueue a NEW-resident run we couldn't transition out of WAITING_FOR_DEPLOY.
    for (const run of legacyRuns) {
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
        new Date(Date.now() + env.LEGACY_RUN_ENGINE_WAITING_FOR_DEPLOY_BATCH_STAGGER_MS)
      );
    }
  }

  static async enqueue(backgroundWorkerId: string, runAt?: Date) {
    return await commonWorker.enqueue({
      id: `v3.executeTasksWaitingForDeploy:${backgroundWorkerId}`,
      job: "v3.executeTasksWaitingForDeploy",
      payload: {
        backgroundWorkerId,
      },
      availableAt: runAt,
    });
  }
}
