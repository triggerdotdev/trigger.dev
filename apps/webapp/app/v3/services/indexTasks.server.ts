import { PrismaClient, prisma } from "~/db.server";
import { socketIo } from "../handleSocketIo.server";

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
      throw new Error(`No image details with this ID: ${imageDetailsId}`);
    }

    if (imageDetails.backgroundWorkerId) {
      throw new Error(`Image details have already been indexed for ID: ${imageDetailsId}`);
    }

    // just broadcast for now - there should only ever be one provider connected
    socketIo.providerNamespace.emit("INDEX", {
      version: "v1",
      contentHash: imageDetails.contentHash,
      imageTag: imageDetails.tag,
    });
  }
}
