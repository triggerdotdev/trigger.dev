import {
  BackgroundTaskImage,
  BackgroundTaskOperation,
  BackgroundTaskVersion,
} from "@trigger.dev/database";
import type { PrismaClient, PrismaClientOrTransaction } from "~/db.server";
import { $transaction, prisma } from "~/db.server";
import { workerQueue } from "../worker.server";
import { AutoScalePoolService } from "./autoScalePool.server";

export class AssignOperationToPoolService {
  #prismaClient: PrismaClientOrTransaction;

  constructor(prismaClient: PrismaClientOrTransaction = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(
    operation: BackgroundTaskOperation,
    version: BackgroundTaskVersion,
    image: BackgroundTaskImage
  ) {
    return await $transaction(this.#prismaClient, async (tx) => {
      const pool = await tx.backgroundTaskMachinePool.upsert({
        where: {
          backgroundTaskVersionId_imageId: {
            backgroundTaskVersionId: version.id,
            imageId: image.id,
          },
        },
        create: {
          backgroundTaskVersionId: version.id,
          imageId: image.id,
          backgroundTaskId: operation.backgroundTaskId,
          provider: image.provider,
          region: version.region,
          cpu: version.cpu,
          memory: version.memory,
          concurrency: version.concurrency,
          diskSize: version.diskSize,
        },
        update: {
          region: version.region,
          cpu: version.cpu,
          memory: version.memory,
          concurrency: version.concurrency,
          diskSize: version.diskSize,
        },
      });

      const updatedOperation = await tx.backgroundTaskOperation.update({
        where: {
          id: operation.id,
        },
        data: {
          status: "ASSIGNED_TO_POOL",
          poolId: pool.id,
        },
      });

      await AutoScalePoolService.enqueue(pool, tx, true);

      return updatedOperation;
    });
  }
}
