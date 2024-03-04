import { CoordinatorToPlatformEvents } from "@trigger.dev/core/v3";
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
    params: Parameters<CoordinatorToPlatformEvents["CHECKPOINT_CREATED"]>[0]
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
        reason: params.reason,
      },
    });

    // TODO: Can't heartbeat when checkpointed, so we ACK to prevent automatic requeue
    // await marqs?.acknowledgeMessage(attempt.taskRunId);

    return checkpoint;
  }
}
