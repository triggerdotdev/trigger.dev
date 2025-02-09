import type { CheckpointRestoreEvent, CheckpointRestoreEventType } from "@trigger.dev/database";
import { logger } from "~/services/logger.server";
import { BaseService } from "./baseService.server";

interface CheckpointRestoreEventCallParams {
  checkpointId: string;
  type: CheckpointRestoreEventType;
  dependencyFriendlyRunId?: string;
  batchDependencyFriendlyId?: string;
}

type CheckpointRestoreEventParams = Omit<CheckpointRestoreEventCallParams, "type">;

export class CreateCheckpointRestoreEventService extends BaseService {
  async checkpoint(params: CheckpointRestoreEventParams) {
    return this.#call({ ...params, type: "CHECKPOINT" });
  }

  async restore(params: CheckpointRestoreEventParams) {
    return this.#call({ ...params, type: "RESTORE" });
  }

  async #call(
    params: CheckpointRestoreEventCallParams
  ): Promise<CheckpointRestoreEvent | undefined> {
    if (params.dependencyFriendlyRunId && params.batchDependencyFriendlyId) {
      logger.error("Only one dependency can be set", { params });
      return;
    }

    const checkpoint = await this._prisma.checkpoint.findFirst({
      where: {
        id: params.checkpointId,
      },
    });

    if (!checkpoint) {
      logger.error("Checkpoint not found", { id: params.checkpointId });
      return;
    }

    logger.debug(`Creating checkpoint/restore event`, { params });

    let taskRunDependencyId: string | undefined;

    if (params.dependencyFriendlyRunId) {
      const run = await this._prisma.taskRun.findFirst({
        where: {
          friendlyId: params.dependencyFriendlyRunId,
        },
        select: {
          id: true,
          dependency: {
            select: {
              id: true,
            },
          },
        },
      });

      taskRunDependencyId = run?.dependency?.id;

      if (!taskRunDependencyId) {
        logger.error("Dependency or run not found", { runId: params.dependencyFriendlyRunId });
        return;
      }
    }

    const checkpointEvent = await this._prisma.checkpointRestoreEvent.create({
      data: {
        checkpointId: checkpoint.id,
        runtimeEnvironmentId: checkpoint.runtimeEnvironmentId,
        projectId: checkpoint.projectId,
        attemptId: checkpoint.attemptId,
        runId: checkpoint.runId,
        type: params.type,
        reason: checkpoint.reason,
        metadata: checkpoint.metadata,
        ...(taskRunDependencyId
          ? {
              taskRunDependency: {
                connect: {
                  id: taskRunDependencyId,
                },
              },
            }
          : undefined),
        ...(params.batchDependencyFriendlyId
          ? {
              batchTaskRunDependency: {
                connect: {
                  friendlyId: params.batchDependencyFriendlyId,
                },
              },
            }
          : undefined),
      },
    });

    return checkpointEvent;
  }
}
