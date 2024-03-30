import { CoordinatorToPlatformMessages, InferSocketMessageSchema } from "@trigger.dev/core/v3";
import type {
  CheckpointRestoreEvent,
  TaskRunAttemptStatus,
  TaskRunStatus,
} from "@trigger.dev/database";
import { logger } from "~/services/logger.server";
import { generateFriendlyId } from "../friendlyIdentifiers";
import { marqs } from "~/v3/marqs/index.server";
import { CreateCheckpointRestoreEventService } from "./createCheckpointRestoreEvent.server";
import { BaseService } from "./baseService.server";

const FREEZABLE_RUN_STATUSES: TaskRunStatus[] = ["EXECUTING", "RETRYING_AFTER_FAILURE"];
const FREEZABLE_ATTEMPT_STATUSES: TaskRunAttemptStatus[] = ["EXECUTING", "FAILED"];

export class CreateCheckpointService extends BaseService {
  public async call(
    params: Omit<
      InferSocketMessageSchema<typeof CoordinatorToPlatformMessages, "CHECKPOINT_CREATED">,
      "version"
    >
  ) {
    logger.debug(`Creating checkpoint`, params);

    const attempt = await this._prisma.taskRunAttempt.findUnique({
      where: {
        friendlyId: params.attemptFriendlyId,
      },
      include: {
        taskRun: true,
        backgroundWorker: {
          select: {
            id: true,
            deployment: {
              select: {
                imageReference: true,
              },
            },
          },
        },
      },
    });

    if (!attempt) {
      logger.error("Attempt not found", { attemptFriendlyId: params.attemptFriendlyId });
      return;
    }

    if (
      !FREEZABLE_ATTEMPT_STATUSES.includes(attempt.status) ||
      !FREEZABLE_RUN_STATUSES.includes(attempt.taskRun.status)
    ) {
      logger.error("Unfreezable state", {
        attempt: {
          id: attempt.id,
          status: attempt.status,
        },
        run: {
          id: attempt.taskRunId,
          status: attempt.taskRun.status,
        },
      });
      return;
    }

    const imageRef = attempt.backgroundWorker.deployment?.imageReference;

    if (!imageRef) {
      logger.error("Missing deployment or image ref", {
        attemptId: attempt.id,
        workerId: attempt.backgroundWorker.id,
      });
      return;
    }

    const checkpoint = await this._prisma.checkpoint.create({
      data: {
        friendlyId: generateFriendlyId("checkpoint"),
        runtimeEnvironmentId: attempt.taskRun.runtimeEnvironmentId,
        projectId: attempt.taskRun.projectId,
        attemptId: attempt.id,
        runId: attempt.taskRunId,
        location: params.location,
        type: params.docker ? "DOCKER" : "KUBERNETES",
        reason: params.reason.type,
        metadata: JSON.stringify(params.reason),
        imageRef,
      },
    });

    const eventService = new CreateCheckpointRestoreEventService(this._prisma);

    await this._prisma.taskRunAttempt.update({
      where: {
        id: attempt.id,
      },
      data: {
        status: params.reason.type === "RETRYING_AFTER_FAILURE" ? undefined : "PAUSED",
        taskRun: {
          update: {
            status: "WAITING_TO_RESUME",
          },
        },
      },
    });

    const { reason } = params;
    let checkpointEvent: CheckpointRestoreEvent | undefined;

    switch (reason.type) {
      case "WAIT_FOR_DURATION": {
        checkpointEvent = await eventService.checkpoint({
          checkpointId: checkpoint.id,
        });

        break;
      }
      case "WAIT_FOR_TASK": {
        checkpointEvent = await eventService.checkpoint({
          checkpointId: checkpoint.id,
          dependencyFriendlyRunId: reason.friendlyId,
        });

        await marqs?.acknowledgeMessage(attempt.taskRunId);
        break;
      }
      case "WAIT_FOR_BATCH": {
        checkpointEvent = await eventService.checkpoint({
          checkpointId: checkpoint.id,
          batchDependencyFriendlyId: reason.batchFriendlyId,
        });

        await marqs?.acknowledgeMessage(attempt.taskRunId);
        break;
      }
      case "RETRYING_AFTER_FAILURE": {
        checkpointEvent = await eventService.checkpoint({
          checkpointId: checkpoint.id,
        });

        // ACK is already handled by attempt completion
        break;
      }
      default: {
        break;
      }
    }

    if (!checkpointEvent) {
      logger.error("No checkpoint event", {
        attemptId: attempt.id,
        checkpointId: checkpoint.id,
      });
      await marqs?.acknowledgeMessage(attempt.taskRunId);
      return;
    }

    if (reason.type === "WAIT_FOR_DURATION") {
      await marqs?.replaceMessage(
        attempt.taskRunId,
        {
          type: "RESUME_AFTER_DURATION",
          resumableAttemptId: attempt.id,
          checkpointEventId: checkpointEvent.id,
        },
        reason.now + reason.ms
      );
    }

    return {
      checkpoint,
      event: checkpointEvent,
    };
  }
}
