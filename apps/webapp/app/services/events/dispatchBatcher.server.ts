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
    let i = 0;

    const chunks: Record<number, string[]> = { 0: [] };

    for (const event of eventRecords) {
      if (event.payloadSize > this.maxPayloadSize) {
        logger.debug("Event payload size is larger than maxPayloadSize", {
          event,
        });
        continue;
      }

      if (chunkSize + event.payloadSize > this.maxPayloadSize) {
        // enqueue full chunk
        await this.#enqueueChunk(eventDispatcher.id, chunks[i]);

        // start new chunk
        i++;
        chunkSize = 0;
        chunks[i] = [];
      }

      chunkSize += event.payloadSize;
      chunks[i].push(event.id);
    }

    if (chunks[i].length) {
      await this.#enqueueChunk(eventDispatcher.id, chunks[i]);
    }
  }

  async #enqueueChunk(dispatcherId: string, eventRecordIds: string[]) {
    logger.debug("Invoking batch event dispatcher", {
      dispatcherId,
      totalEvents: eventRecordIds.length,
    });

    await workerQueue.enqueue("events.invokeBatchDispatcher", { id: dispatcherId, eventRecordIds });
  }
}
