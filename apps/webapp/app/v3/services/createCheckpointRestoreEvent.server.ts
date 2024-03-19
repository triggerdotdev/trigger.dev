import type { CheckpointRestoreEvent, CheckpointRestoreEventType } from "@trigger.dev/database";
import { $transaction, PrismaClient, prisma } from "~/db.server";
import { logger } from "~/services/logger.server";

export class CreateCheckpointRestoreEventService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(params: {
    checkpointId: string;
    type: CheckpointRestoreEventType;
  }): Promise<CheckpointRestoreEvent | undefined> {
    return await $transaction(this.#prismaClient, async (tx) => {
      const checkpoint = await this.#prismaClient.checkpoint.findUniqueOrThrow({
        where: {
          id: params.checkpointId,
        },
      });

      logger.debug(`Creating checkpoint/restore event`, params);

      const checkpointEvent = await this.#prismaClient.checkpointRestoreEvent.create({
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
    });
  }
}
