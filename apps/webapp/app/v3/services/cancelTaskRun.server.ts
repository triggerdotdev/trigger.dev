import { RunEngineVersion, type TaskRun } from "@trigger.dev/database";
import { runOpsLegacyPrismaClient } from "~/db.server";
import { engine } from "../runEngine.server";
import { isCancellableRunStatus } from "../taskStatus";
import { BaseService } from "./baseService.server";

export type CancelTaskRunServiceOptions = {
  reason?: string;
  cancelAttempts?: boolean;
  cancelledAt?: Date;
  bulkActionId?: string;
  /** Skip PENDING_CANCEL and finalize immediately (use when the worker is known to be dead). */
  finalizeRun?: boolean;
};

type CancelTaskRunServiceResult = {
  id: string;
  alreadyFinished: boolean;
};

export type CancelableTaskRun = Pick<
  TaskRun,
  "id" | "engine" | "status" | "friendlyId" | "taskEventStore" | "createdAt" | "completedAt"
>;

export class CancelTaskRunService extends BaseService {
  public async call(
    taskRun: CancelableTaskRun,
    options?: CancelTaskRunServiceOptions
  ): Promise<CancelTaskRunServiceResult | undefined> {
    if (taskRun.engine === RunEngineVersion.V1) {
      return await this.callV1(taskRun, options);
    } else {
      return await this.callV2(taskRun, options);
    }
  }

  private async callV1(
    taskRun: CancelableTaskRun,
    options?: CancelTaskRunServiceOptions
  ): Promise<CancelTaskRunServiceResult | undefined> {
    // v3 (engine V1) execution is retired: there are no V1 workers or coordinator
    // left to signal. A historical V1 run can still be cancelled by finalizing its
    // DB row directly. Never throw here: the cancel route returns 500 on any throw.
    if (!isCancellableRunStatus(taskRun.status)) {
      if (options?.bulkActionId) {
        await runOpsLegacyPrismaClient.taskRun.update({
          where: { id: taskRun.id },
          data: { bulkActionGroupIds: { push: options.bulkActionId } },
        });
      }
      return { id: taskRun.id, alreadyFinished: true };
    }

    await runOpsLegacyPrismaClient.taskRun.update({
      where: { id: taskRun.id },
      data: {
        status: "CANCELED",
        completedAt: options?.cancelledAt ?? new Date(),
        bulkActionGroupIds: options?.bulkActionId ? { push: options.bulkActionId } : undefined,
      },
    });

    return { id: taskRun.id, alreadyFinished: false };
  }

  private async callV2(
    taskRun: CancelableTaskRun,
    options?: CancelTaskRunServiceOptions
  ): Promise<CancelTaskRunServiceResult | undefined> {
    const result = await engine.cancelRun({
      runId: taskRun.id,
      completedAt: options?.cancelledAt,
      reason: options?.reason,
      finalizeRun: options?.finalizeRun,
      bulkActionId: options?.bulkActionId,
      tx: this._prisma,
    });

    return {
      id: result.run.id,
      alreadyFinished: result.alreadyFinished,
    };
  }
}
