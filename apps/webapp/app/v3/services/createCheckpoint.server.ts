import { CoordinatorToPlatformMessages, InferSocketMessageSchema } from "@trigger.dev/core/v3";
import type { Checkpoint } from "@trigger.dev/database";
import { PrismaClient, prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { generateFriendlyId } from "../friendlyIdentifiers";
import { marqs } from "../marqs.server";
import { CreateCheckpointRestoreEventService } from "./createCheckpointRestoreEvent.server";

export class CreateCheckpointService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(
    params: Omit<
      InferSocketMessageSchema<typeof CoordinatorToPlatformMessages, "CHECKPOINT_CREATED">,
      "version"
    >
  ): Promise<Checkpoint | undefined> {
    logger.debug(`Creating checkpoint`, params);

    const isFriendlyId = (id: string) => {
      return id.startsWith("attempt_");
    };

    const attempt = await this.#prismaClient.taskRunAttempt.findUnique({
      where: isFriendlyId(params.attemptId)
        ? {
            friendlyId: params.attemptId,
          }
        : {
            id: params.attemptId,
          },
      include: {
        taskRun: true,
        backgroundWorker: {
          select: {
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
      logger.error("Attempt not found", { attemptId: params.attemptId });
      return;
    }

    const imageRef = attempt.backgroundWorker.deployment?.imageReference;

    if (!imageRef) {
      logger.error("No image ref", { attemptId: params.attemptId });
      return;
    }

    const checkpoint = await this.#prismaClient.checkpoint.create({
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

    const eventService = new CreateCheckpointRestoreEventService(this.#prismaClient);
    await eventService.call({ checkpointId: checkpoint.id, type: "CHECKPOINT" });

    await this.#prismaClient.taskRunAttempt.update({
      where: {
        id: attempt.id,
      },
      data: {
        status: "PAUSED",
        taskRun: {
          update: {
            status:
              params.reason.type === "RETRYING_AFTER_FAILURE"
                ? "RETRYING_AFTER_FAILURE"
                : "WAITING_TO_RESUME",
          },
        },
      },
    });

    switch (params.reason.type) {
      case "WAIT_FOR_DURATION": {
        await marqs?.replaceMessage(
          attempt.taskRunId,
          { type: "RESUME_AFTER_DURATION", resumableAttemptId: attempt.id },
          Date.now() + params.reason.ms
        );
        break;
      }
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

    return checkpoint;
  }
}
