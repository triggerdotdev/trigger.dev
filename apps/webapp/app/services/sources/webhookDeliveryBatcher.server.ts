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

  public async call(id: string, deliveryIds: string[]) {
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
      SELECT id, OCTET_LENGTH(body) AS "bodySize" FROM "WebhookRequestDelivery"
      WHERE id IN (${Prisma.join(deliveryIds)});
    `;

    let chunkSize = 0;
    let i = 0;

    const chunks: Record<number, string[]> = { 0: [] };

    for (const delivery of requestDeliveries) {
      if (delivery.bodySize > this.maxPayloadSize) {
        logger.debug("Delivery body size is larger than maxPayloadSize", {
          delivery,
        });
        continue;
      }

      if (chunkSize + delivery.bodySize > this.maxPayloadSize) {
        // enqueue full chunk
        await this.#enqueueChunk(webhookEnvironment.id, chunks[i]);

        // start new chunk
        i++;
        chunkSize = 0;
        chunks[i] = [];
      }

      chunkSize += delivery.bodySize;
      chunks[i].push(delivery.id);
    }

    if (chunks[i].length) {
      await this.#enqueueChunk(webhookEnvironment.id, chunks[i]);
    }
  }

  async #enqueueChunk(webhookEnvironmentId: string, requestDeliveryIds: string[]) {
    logger.debug("Invoking batch webhook delivery", {
      webhookEnvironmentId,
      totalDeliveries: requestDeliveryIds.length,
    });

    await workerQueue.enqueue("deliverMultipleWebhookRequests", {
      webhookEnvironmentId,
      requestDeliveryIds,
    });
  }
}
