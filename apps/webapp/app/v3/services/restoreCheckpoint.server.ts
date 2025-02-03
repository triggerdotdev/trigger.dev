import { type Checkpoint } from "@trigger.dev/database";
import { logger } from "~/services/logger.server";
import { socketIo } from "../handleSocketIo.server";
import { machinePresetFromConfig, machinePresetFromRun } from "../machinePresets.server";
import { BaseService } from "./baseService.server";
import { CreateCheckpointRestoreEventService } from "./createCheckpointRestoreEvent.server";
import { isRestorableAttemptStatus, isRestorableRunStatus } from "../taskStatus";

export class RestoreCheckpointService extends BaseService {
  public async call(params: {
    eventId: string;
    isRetry?: boolean;
  }): Promise<Checkpoint | undefined> {
    logger.debug(`Restoring checkpoint`, params);

    const checkpointEvent = await this._prisma.checkpointRestoreEvent.findFirst({
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
                machinePreset: true,
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
      logger.error("Checkpoint event not found", { eventId: params.eventId });
      return;
    }

    const checkpoint = checkpointEvent.checkpoint;

    if (!isRestorableRunStatus(checkpoint.run.status)) {
      logger.error("Run is unrestorable", {
        eventId: params.eventId,
        runId: checkpoint.runId,
        runStatus: checkpoint.run.status,
        attemptId: checkpoint.attemptId,
      });
      return;
    }

    if (!isRestorableAttemptStatus(checkpoint.attempt.status) && !params.isRetry) {
      logger.error("Attempt is unrestorable", {
        eventId: params.eventId,
        runId: checkpoint.runId,
        attemptId: checkpoint.attemptId,
        attemptStatus: checkpoint.attempt.status,
      });
      return;
    }

    const machine =
      machinePresetFromRun(checkpoint.run) ??
      machinePresetFromConfig(checkpoint.attempt.backgroundWorkerTask.machineConfig ?? {});

    const restoreEvent = await this._prisma.checkpointRestoreEvent.findFirst({
      where: {
        checkpointId: checkpoint.id,
        type: "RESTORE",
      },
    });

    if (restoreEvent) {
      logger.error("Restore event already exists", {
        runId: checkpoint.runId,
        attemptId: checkpoint.attemptId,
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
      machine,
      attemptNumber: checkpoint.attemptNumber ?? undefined,
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

  async getLastCheckpointEventIfUnrestored(runId: string) {
    const event = await this._prisma.checkpointRestoreEvent.findFirst({
      where: {
        runId,
      },
      take: 1,
      orderBy: {
        createdAt: "desc",
      },
    });

    if (!event) {
      return;
    }

    if (event.type === "CHECKPOINT") {
      return event;
    }
  }
}
