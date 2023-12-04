import type { PrismaClientOrTransaction } from "~/db.server";
import { Prisma, prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { workerQueue } from "../worker.server";

const DEFAULT_MAX_PAYLOAD_SIZE = 2 * 1024 * 1024; // 2MB

export class DispatchBatcherService {
  #prismaClient: PrismaClientOrTransaction;

  constructor(
    private maxPayloadSize = DEFAULT_MAX_PAYLOAD_SIZE,
    prismaClient: PrismaClientOrTransaction = prisma
  ) {
    this.#prismaClient = prismaClient;
  }

  public async call(id: string, eventRecordIds: string[]) {
    const eventDispatcher = await this.#prismaClient.eventDispatcher.findUniqueOrThrow({
      where: {
        id,
      },
      include: {
        batcher: true,
      },
    });

    if (!eventDispatcher.enabled) {
      logger.debug("Event dispatcher is disabled", {
        eventDispatcher,
      });

      return;
    }

    if (!eventDispatcher.batcher) {
      logger.debug("Dispatcher has no batcher", {
        eventDispatcher,
      });

      return;
    }

    const eventRecords = await prisma.$queryRaw<{ id: string; payloadSize: number }[]>`
      SELECT id, LENGTH(payload::text) AS "payloadSize" FROM "EventRecord"
      WHERE id IN (${Prisma.join(eventRecordIds)});
    `;

    let chunkSize = 0;
    let chunkIndex = 0;

    const chunks: Record<number, string[]> = { 0: [] };

    for (const event of eventRecords) {
      logger.debug("Event payload size is larger than maxPayloadSize", {
        event,
      });

      if (event.payloadSize > this.maxPayloadSize) {
        continue;
      }

      if (chunkSize + event.payloadSize > this.maxPayloadSize) {
        // enqueue full chunk
        await this.#enqueueChunk(
          eventDispatcher.id,
          chunks[chunkIndex],
          eventDispatcher.batcher.maxInterval
        );

        // start new chunk
        chunkIndex++;
        chunkSize = 0;
        chunks[chunkIndex] = [];
      }

      chunkSize += event.payloadSize;
      chunks[chunkIndex].push(event.id);
    }

    if (chunks[chunkIndex].length) {
      await this.#enqueueChunk(
        eventDispatcher.id,
        chunks[chunkIndex],
        eventDispatcher.batcher.maxInterval
      );
    }
  }

  async #enqueueChunk(dispatcherId: string, eventRecordIds: string[], maxInterval: number | null) {
    logger.debug("Invoking batch event dispatcher", {
      dispatcherId,
      totalEvents: eventRecordIds.length,
    });

    const MAX_INTERVAL_IN_SECONDS = 10 * 60;

    const deliverAfter = maxInterval ? Math.max(maxInterval, MAX_INTERVAL_IN_SECONDS) : undefined;

    await workerQueue.enqueue(
      "events.invokeBatchDispatcher",
      { id: dispatcherId, eventRecordIds }
      // { runAt: deliverAfter ? deliverAfterToDate(deliverAfter) : undefined }
    );
  }
}

const deliverAfterToDate = (seconds: number) => new Date(Date.now() + seconds * 1000);
