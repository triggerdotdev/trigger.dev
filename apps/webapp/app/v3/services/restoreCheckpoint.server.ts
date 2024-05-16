import { TaskRunStatus, type Checkpoint, TaskRunAttemptStatus } from "@trigger.dev/database";
import { logger } from "~/services/logger.server";
import { socketIo } from "../handleSocketIo.server";
import { CreateCheckpointRestoreEventService } from "./createCheckpointRestoreEvent.server";
import { BaseService } from "./baseService.server";
import { Machine } from "@trigger.dev/core/v3";

const RESTORABLE_RUN_STATUSES: TaskRunStatus[] = ["WAITING_TO_RESUME"];
const RESTORABLE_ATTEMPT_STATUSES: TaskRunAttemptStatus[] = ["PAUSED"];

export class RestoreCheckpointService extends BaseService {
  public async call(params: {
    eventId: string;
    isRetry?: boolean;
  }): Promise<Checkpoint | undefined> {
    logger.debug(`Restoring checkpoint`, params);

    const checkpointEvent = await this._prisma.checkpointRestoreEvent.findUnique({
      where: {
        id: params.eventId,
        type: "CHECKPOINT",
      },
      include: {
        checkpoint: {
          include: {
            run: {
              select: {
                status: true,
              },
            },
            attempt: {
              select: {
                status: true,
                backgroundWorkerTask: {
                  select: {
                    machineConfig: true,
                  },
                },
              },
            },
            runtimeEnvironment: true,
          },
        },
      },
    });

    if (!checkpointEvent) {
      logger.error("Checkpoint event not found", params);
      return;
    }

    const checkpoint = checkpointEvent.checkpoint;

    const runIsRestorable = RESTORABLE_RUN_STATUSES.includes(checkpoint.run.status);
    const attemptIsRestorable = RESTORABLE_ATTEMPT_STATUSES.includes(checkpoint.attempt.status);

    if (!runIsRestorable) {
      logger.error("Run is unrestorable", {
        id: checkpoint.runId,
        status: checkpoint.run.status,
      });
      return;
    }

    if (!attemptIsRestorable && !params.isRetry) {
      logger.error("Attempt is unrestorable", {
        id: checkpoint.attemptId,
        status: checkpoint.attempt.status,
      });
      return;
    }

    const { machineConfig } = checkpoint.attempt.backgroundWorkerTask;
    const machine = Machine.safeParse(machineConfig ?? {});

    if (!machine.success) {
      logger.error("Failed to parse machine config", {
        attemptId: checkpoint.attemptId,
        machineConfig: checkpoint.attempt.backgroundWorkerTask.machineConfig,
      });
      return;
    }

    const restoreEvent = await this._prisma.checkpointRestoreEvent.findFirst({
      where: {
        checkpointId: checkpoint.id,
        type: "RESTORE",
      },
    });

    if (restoreEvent) {
      logger.error("Restore event already exists", {
        checkpointId: checkpoint.id,
        restoreEventId: restoreEvent.id,
      });

      return;
    }

    const eventService = new CreateCheckpointRestoreEventService(this._prisma);
    await eventService.restore({ checkpointId: checkpoint.id });

    socketIo.providerNamespace.emit("RESTORE", {
      version: "v1",
      type: checkpoint.type,
      location: checkpoint.location,
      reason: checkpoint.reason ?? undefined,
      imageRef: checkpoint.imageRef,
      machine: machine.data,
      // identifiers
      checkpointId: checkpoint.id,
      envId: checkpoint.runtimeEnvironment.id,
      envType: checkpoint.runtimeEnvironment.type,
      orgId: checkpoint.runtimeEnvironment.organizationId,
      projectId: checkpoint.runtimeEnvironment.projectId,
      runId: checkpoint.runId,
    });

    return checkpoint;
  }
}
