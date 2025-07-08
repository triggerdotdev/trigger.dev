import { RunEngineVersion, type TaskRun } from "@trigger.dev/database";
import { logger } from "~/services/logger.server";
import { eventRepository } from "../eventRepository.server";
import { engine } from "../runEngine.server";
import { getTaskEventStoreTableForRun } from "../taskEventStore.server";
import { BaseService } from "./baseService.server";
import { CancelTaskRunServiceV1 } from "./cancelTaskRunV1.server";

export type CancelTaskRunServiceOptions = {
  reason?: string;
  cancelAttempts?: boolean;
  cancelledAt?: Date;
  bulkActionId?: string;
};

type CancelTaskRunServiceResult = {
  id: string;
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
    const service = new CancelTaskRunServiceV1(this._prisma);
    return await service.call(taskRun, options);
  }

  private async callV2(
    taskRun: CancelableTaskRun,
    options?: CancelTaskRunServiceOptions
  ): Promise<CancelTaskRunServiceResult | undefined> {
    //todo bulkActionId
    const result = await engine.cancelRun({
      runId: taskRun.id,
      completedAt: options?.cancelledAt,
      reason: options?.reason,
      bulkActionId: options?.bulkActionId,
      tx: this._prisma,
    });

    return {
      id: result.run.id,
    };
  }
}
