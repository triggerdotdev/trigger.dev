import { type Checkpoint } from "@trigger.dev/database";
import { runOpsLegacyPrisma } from "~/db.server";
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

    // Checkpoint / CheckpointRestoreEvent are V1-only run-graph models (ids default to cuid and
    // are only ever written for legacy runs), so they always live on the legacy run store. Read
    // them via the legacy handle, and resolve the cross-store control-plane relations
    // (RuntimeEnvironment, BackgroundWorkerTask) separately off the control-plane client below.
    const checkpointEvent = await runOpsLegacyPrisma.checkpointRestoreEvent.findFirst({
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
                backgroundWorkerTaskId: true,
              },
            },
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

    // BackgroundWorkerTask lives on the control plane — resolve its machine config there rather
    // than joining across the run store seam.
    const backgroundWorkerTask = await this._prisma.backgroundWorkerTask.findFirst({
      where: { id: checkpoint.attempt.backgroundWorkerTaskId },
      select: { machineConfig: true },
    });

    const machine =
      machinePresetFromRun(checkpoint.run) ??
      machinePresetFromConfig(backgroundWorkerTask?.machineConfig ?? {});

    const restoreEvent = await runOpsLegacyPrisma.checkpointRestoreEvent.findFirst({
      where: {
        checkpointId: checkpoint.id,
        type: "RESTORE",
      },
    });

    if (restoreEvent) {
      logger.warn("Restore event already exists", {
        runId: checkpoint.runId,
        attemptId: checkpoint.attemptId,
        checkpointId: checkpoint.id,
        restoreEventId: restoreEvent.id,
      });

      return;
    }

    // RuntimeEnvironment lives on the control plane — resolve it there instead of joining across
    // the run store seam.
    const runtimeEnvironment = await this._prisma.runtimeEnvironment.findFirst({
      where: { id: checkpoint.runtimeEnvironmentId },
    });

    if (!runtimeEnvironment) {
      logger.error("Runtime environment not found for checkpoint", {
        eventId: params.eventId,
        runId: checkpoint.runId,
        checkpointId: checkpoint.id,
        runtimeEnvironmentId: checkpoint.runtimeEnvironmentId,
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
      envId: runtimeEnvironment.id,
      envType: runtimeEnvironment.type,
      orgId: runtimeEnvironment.organizationId,
      projectId: runtimeEnvironment.projectId,
      runId: checkpoint.runId,
    });

    return checkpoint;
  }

  async getLastCheckpointEventIfUnrestored(runId: string) {
    const event = await runOpsLegacyPrisma.checkpointRestoreEvent.findFirst({
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
