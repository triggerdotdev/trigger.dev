import type {
  Checkpoint,
  CheckpointRestoreEvent,
  CheckpointRestoreEventType,
} from "@trigger.dev/database";
import { logger } from "~/services/logger.server";
import { BaseService } from "./baseService.server";
import { ManualCheckpointMetadata } from "@trigger.dev/core/v3";
import { isTaskRunAttemptStatus, isTaskRunStatus, TaskRunAttemptStatus } from "~/database-types";
import { safeJsonParse } from "~/utils/json";

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

    if (params.type === "RESTORE" && checkpoint.reason === "MANUAL") {
      const manualRestoreSuccess = await this.#handleManualCheckpointRestore(checkpoint);
      if (!manualRestoreSuccess) {
        return;
      }
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

  async #handleManualCheckpointRestore(checkpoint: Checkpoint): Promise<boolean> {
    const json = checkpoint.metadata ? safeJsonParse(checkpoint.metadata) : undefined;

    // We need to restore the previous run and attempt status as saved in the metadata
    const metadata = ManualCheckpointMetadata.safeParse(json);

    if (!metadata.success) {
      logger.error("Invalid metadata", { metadata });
      return false;
    }

    const { attemptId, previousAttemptStatus, previousRunStatus } = metadata.data;

    if (!isTaskRunAttemptStatus(previousAttemptStatus)) {
      logger.error("Invalid previous attempt status", { previousAttemptStatus });
      return false;
    }

    if (!isTaskRunStatus(previousRunStatus)) {
      logger.error("Invalid previous run status", { previousRunStatus });
      return false;
    }

    try {
      const updatedAttempt = await this._prisma.taskRunAttempt.update({
        where: {
          id: attemptId,
        },
        data: {
          status: previousAttemptStatus,
          taskRun: {
            update: {
              data: {
                status: previousRunStatus,
              },
            },
          },
        },
        select: {
          id: true,
          status: true,
          taskRun: {
            select: {
              id: true,
              status: true,
            },
          },
        },
      });

      logger.debug("Set post resume statuses after manual checkpoint", {
        run: {
          id: updatedAttempt.taskRun.id,
          status: updatedAttempt.taskRun.status,
        },
        attempt: {
          id: updatedAttempt.id,
          status: updatedAttempt.status,
        },
      });

      return true;
    } catch (error) {
      logger.error("Failed to set post resume statuses", {
        error:
          error instanceof Error
            ? {
                name: error.name,
                message: error.message,
                stack: error.stack,
              }
            : error,
      });
      return false;
    }
  }
}
