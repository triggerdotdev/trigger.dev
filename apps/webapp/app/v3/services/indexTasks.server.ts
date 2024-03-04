import { PrismaClient, prisma } from "~/db.server";
import { socketIo } from "../handleSocketIo.server";
import { logger } from "~/services/logger.server";

export type IndexTasksServiceOptions = {
  idempotencyKey?: string;
  triggerVersion?: string;
  traceContext?: Record<string, string | undefined>;
};

export class IndexTasksService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(imageDetailsId: string) {
    const imageDetails = await this.#prismaClient.imageDetails.findUnique({
      where: {
        id: imageDetailsId,
      },
    });

    if (!imageDetails) {
      logger.error(`No image details with this ID: ${imageDetailsId}`);
      return;
    }

    if (imageDetails.backgroundWorkerId) {
      logger.debug(
        `Image details have already been indexed for ${imageDetails.friendlyId}. Refreshing worker timestamp.`
      );
      await this.#prismaClient.backgroundWorker.update({
        where: {
          id: imageDetails.backgroundWorkerId,
        },
        data: {
          updatedAt: new Date(),
        },
      });
      return;
    }

    // just broadcast for now - there should only ever be one provider connected
    socketIo.providerNamespace.emit("INDEX", {
      version: "v1",
      contentHash: imageDetails.contentHash,
      imageTag: imageDetails.tag,
      envId: imageDetails.runtimeEnvironmentId,
    });
  }
}
