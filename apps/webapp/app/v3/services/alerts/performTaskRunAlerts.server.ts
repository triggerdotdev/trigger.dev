import { type RunStore } from "@internal/run-store";
import { type Prisma, type ProjectAlertChannel } from "@trigger.dev/database";
import { type PrismaClientOrTransaction, type prisma } from "~/db.server";
import { alertsWorker } from "~/v3/alertsWorker.server";
import type { ControlPlaneResolver } from "~/v3/runOpsMigration/controlPlaneResolver.server";
import { controlPlaneResolver as defaultControlPlaneResolver } from "~/v3/runOpsMigration/controlPlaneResolver.server";
import { BaseService } from "../baseService.server";
import { DeliverAlertService } from "./deliverAlert.server";

// The alert hydration reads only run-ops scalars (id/projectId/runtimeEnvironmentId); the env's
// type (and its parent's) is resolved via the control-plane resolver so the run-ops DB can split
// without a cross-provider join. The prior `lockedBy` + `runtimeEnvironment` includes were unused.
type FoundRun = Prisma.Result<
  typeof prisma.taskRun,
  { select: { id: true; projectId: true; runtimeEnvironmentId: true } },
  "findUniqueOrThrow"
>;

export class PerformTaskRunAlertsService extends BaseService {
  #controlPlaneResolver: ControlPlaneResolver;

  constructor(
    opts: {
      prisma?: PrismaClientOrTransaction;
      replica?: PrismaClientOrTransaction;
      runStore?: RunStore;
      controlPlaneResolver?: ControlPlaneResolver;
    } = {}
  ) {
    super(opts.prisma, opts.replica, opts.runStore);
    this.#controlPlaneResolver = opts.controlPlaneResolver ?? defaultControlPlaneResolver;
  }

  public async call(runId: string) {
    const run = await this.runStore.findRun(
      { id: runId },
      {
        select: {
          id: true,
          projectId: true,
          runtimeEnvironmentId: true,
        },
      },
      this._prisma
    );

    if (!run) {
      return;
    }

    const env = await this.#controlPlaneResolver.resolveEnv(run.runtimeEnvironmentId);

    if (!env) {
      return;
    }

    const alertChannels = await this._prisma.projectAlertChannel.findMany({
      where: {
        projectId: run.projectId,
        alertTypes: {
          has: "TASK_RUN",
        },
        environmentTypes: {
          has: env.parentEnvironmentType ?? env.type,
        },
        enabled: true,
      },
    });

    for (const alertChannel of alertChannels) {
      await this.#createAndSendAlert(alertChannel, run);
    }
  }

  async #createAndSendAlert(alertChannel: ProjectAlertChannel, run: FoundRun) {
    await DeliverAlertService.createAndSendAlert(
      {
        channelId: alertChannel.id,
        channelType: alertChannel.type,
        projectId: run.projectId,
        environmentId: run.runtimeEnvironmentId,
        alertType: "TASK_RUN",
        taskRunId: run.id,
      },
      this._prisma
    );
  }

  static async enqueue(runId: string, runAt?: Date) {
    return await alertsWorker.enqueue({
      id: `performTaskRunAlerts:${runId}`,
      job: "v3.performTaskRunAlerts",
      payload: { runId },
      availableAt: runAt,
    });
  }
}
