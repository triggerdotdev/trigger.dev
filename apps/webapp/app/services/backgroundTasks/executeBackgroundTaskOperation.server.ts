import { PrismaClient } from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { AssignOperationToPoolService } from "./assignOperationToPool.server";

export class ExecuteBackgroundTaskOperationService {
  #prismaClient: PrismaClient;
  #assignOperationToPoolService = new AssignOperationToPoolService();

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(id: string) {
    const operation = await this.#prismaClient.backgroundTaskOperation.findUniqueOrThrow({
      where: {
        id,
      },
      include: {
        backgroundTask: true,
        backgroundTaskVersion: true,
      },
    });

    // Find the BackgroundTaskImage
    const image = await this.#prismaClient.backgroundTaskImage.findFirst({
      where: {
        backgroundTaskId: operation.backgroundTaskId,
        tag: operation.backgroundTaskVersion.version,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    // If the image is not found, we need to wait for it to be deployed
    if (!image) {
      await this.#prismaClient.backgroundTaskOperation.update({
        where: {
          id,
        },
        data: {
          status: "WAITING_ON_IMAGE",
        },
      });

      return;
    }

    return await this.#assignOperationToPoolService.call(
      operation,
      operation.backgroundTaskVersion,
      image
    );
  }
}
