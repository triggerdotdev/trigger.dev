import type { PrismaClientOrTransaction } from "~/db.server";
import { Prisma, prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { workerQueue } from "../worker.server";

const DEFAULT_MAX_PAYLOAD_SIZE = 2 * 1024 * 1024; // 2MB

export class WebhookDeliveryBatcherService {
  #prismaClient: PrismaClientOrTransaction;

  constructor(
    private maxPayloadSize = DEFAULT_MAX_PAYLOAD_SIZE,
    prismaClient: PrismaClientOrTransaction = prisma
  ) {
    this.#prismaClient = prismaClient;
  }

  public async call(id: string, eventRecordIds: string[]) {
    const webhookEnvironment = await this.#prismaClient.webhookEnvironment.findUniqueOrThrow({
      where: {
        id,
      },
      include: {
        deliveryBatcher: true,
      },
    });

    if (!webhookEnvironment.active) {
      logger.debug("Webhook environment is disabled", {
        webhookEnvironment,
      });

      return;
    }

    const batcher = webhookEnvironment.deliveryBatcher;

    if (!batcher) {
      logger.debug("Webhook environment has no batcher", {
        webhookEnvironment,
      });

      return;
    }

    const requestDeliveries = await prisma.$queryRaw<{ id: string; bodySize: number }[]>`
      SELECT id, LENGTH(payload::text) AS "bodySize" FROM "WebhookRequestDelivery"
      WHERE id IN (${Prisma.join(eventRecordIds)});
    `;

    let chunkSize = 0;
    let chunkIndex = 0;

    const chunks: Record<number, string[]> = { 0: [] };

    for (const delivery of requestDeliveries) {
      logger.debug("Delivery body size is larger than maxPayloadSize", {
        delivery,
      });

      if (delivery.bodySize > this.maxPayloadSize) {
        continue;
      }

      if (chunkSize + delivery.bodySize > this.maxPayloadSize) {
        // enqueue full chunk
        await this.#enqueueChunk(webhookEnvironment.id, chunks[chunkIndex], batcher.maxInterval);

        // start new chunk
        chunkIndex++;
        chunkSize = 0;
        chunks[chunkIndex] = [];
      }

      chunkSize += delivery.bodySize;
      chunks[chunkIndex].push(delivery.id);
    }

    if (chunks[chunkIndex].length) {
      await this.#enqueueChunk(webhookEnvironment.id, chunks[chunkIndex], batcher.maxInterval);
    }
  }

  async #enqueueChunk(
    webhookEnvironmentId: string,
    requestDeliveryIds: string[],
    maxInterval: number | null
  ) {
    logger.debug("Invoking batch webhook delivery", {
      webhookEnvironmentId,
      totalDeliveries: requestDeliveryIds.length,
    });

    const MAX_INTERVAL_IN_SECONDS = 10 * 60;

    const deliverAfter = maxInterval ? Math.max(maxInterval, MAX_INTERVAL_IN_SECONDS) : undefined;

    await workerQueue.enqueue(
      "deliverMultipleWebhookRequests",
      { webhookEnvironmentId, requestDeliveryIds }
      // { runAt: deliverAfter ? deliverAfterToDate(deliverAfter) : undefined }
    );
  }
}

const deliverAfterToDate = (seconds: number) => new Date(Date.now() + seconds * 1000);
