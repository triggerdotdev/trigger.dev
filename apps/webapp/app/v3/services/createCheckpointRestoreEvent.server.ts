import type { CheckpointRestoreEvent, CheckpointRestoreEventType } from "@trigger.dev/database";
import { logger } from "~/services/logger.server";
import { BaseService } from "./baseService.server";

export class CreateCheckpointRestoreEventService extends BaseService {

  public async call(params: {
    checkpointId: string;
    type: CheckpointRestoreEventType;
  }): Promise<CheckpointRestoreEvent | undefined> {
    const checkpoint = await this._prisma.checkpoint.findUniqueOrThrow({
      where: {
        id: params.checkpointId,
      },
    });

    logger.debug(`Creating checkpoint/restore event`, params);

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
      },
    });

    return checkpointEvent;
  }
}
