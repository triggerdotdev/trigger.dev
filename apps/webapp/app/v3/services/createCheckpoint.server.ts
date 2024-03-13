import { CoordinatorToPlatformMessages, InferSocketMessageSchema } from "@trigger.dev/core/v3";
import type { Checkpoint } from "@trigger.dev/database";
import { PrismaClient, prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { generateFriendlyId } from "../friendlyIdentifiers";
import { marqs } from "../marqs.server";

export class CreateCheckpointService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(
    params: InferSocketMessageSchema<typeof CoordinatorToPlatformMessages, "CHECKPOINT_CREATED">
  ): Promise<Checkpoint> {
    const attempt = await this.#prismaClient.taskRunAttempt.findUniqueOrThrow({
      where: {
        id: params.attemptId,
      },
      include: {
        taskRun: true,
      },
    });

    logger.debug(`Creating checkpoint`, params);

    const checkpoint = await this.#prismaClient.checkpoint.create({
      data: {
        friendlyId: generateFriendlyId("checkpoint"),
        runtimeEnvironmentId: attempt.taskRun.runtimeEnvironmentId,
        projectId: attempt.taskRun.projectId,
        attemptId: attempt.id,
        location: params.location,
        type: params.docker ? "DOCKER" : "KUBERNETES",
        reason: params.reason.type,
      },
    });

    await this.#prismaClient.taskRunAttempt.update({
      where: {
        id: params.attemptId,
      },
      data: {
        status: "PAUSED",
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
      default: {
        break;
      }
    }

    return checkpoint;
  }
}
