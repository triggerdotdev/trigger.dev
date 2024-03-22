import { CoordinatorToPlatformMessages, InferSocketMessageSchema } from "@trigger.dev/core/v3";
import type { TaskRunAttemptStatus, TaskRunStatus } from "@trigger.dev/database";
import { logger } from "~/services/logger.server";
import { generateFriendlyId } from "../friendlyIdentifiers";
import { marqs } from "../marqs.server";
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
    const checkpointEvent = await eventService.call({
      checkpointId: checkpoint.id,
      type: "CHECKPOINT",
    });

    if (!checkpointEvent) {
      logger.error("No checkpoint event", {
        attemptId: attempt.id,
        checkpointId: checkpoint.id,
      });
      return;
    }

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

    switch (params.reason.type) {
      case "WAIT_FOR_DURATION": {
        await marqs?.replaceMessage(
          attempt.taskRunId,
          {
            type: "RESUME_AFTER_DURATION",
            resumableAttemptId: attempt.id,
            checkpointEventId: checkpointEvent.id,
          },
          params.reason.now + params.reason.ms
        );
        break;
      }
      // TODO: Attach the checkpoint event ID to in-progress dependencies
      case "WAIT_FOR_TASK":
      case "WAIT_FOR_BATCH": {
        await marqs?.acknowledgeMessage(attempt.taskRunId);
        break;
      }
      case "RETRYING_AFTER_FAILURE": {
        // ACK is already handled by attempt completion
        break;
      }
      default: {
        break;
      }
    }

    return {
      checkpoint,
      event: checkpointEvent,
    };
  }
}
