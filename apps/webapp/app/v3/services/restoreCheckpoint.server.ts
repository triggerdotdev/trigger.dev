import { type Checkpoint } from "@trigger.dev/database";
import { PrismaClient, prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { socketIo } from "../handleSocketIo.server";
import { CreateCheckpointRestoreEventService } from "./createCheckpointRestoreEvent.server";

export class RestoreCheckpointService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(params: { checkpointId: string }): Promise<Checkpoint> {
    logger.debug(`Restoring checkpoint`, params);

    const checkpoint = await this.#prismaClient.checkpoint.findUniqueOrThrow({
      where: {
        id: params.checkpointId,
      },
    });

    const eventService = new CreateCheckpointRestoreEventService(this.#prismaClient);
    await eventService.call({ checkpointId: checkpoint.id, type: "RESTORE" });

    socketIo.providerNamespace.emit("RESTORE", {
      version: "v1",
      checkpointId: checkpoint.id,
      runId: checkpoint.runId,
      attemptId: checkpoint.attemptId,
      type: checkpoint.type,
      location: checkpoint.location,
      reason: checkpoint.reason ?? undefined,
    });

    return checkpoint;
  }
}
