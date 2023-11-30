import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { workerQueue } from "../worker.server";
import { RuntimeEnvironmentType } from "@trigger.dev/database";
import { createHttpSourceRequest } from "~/utils/createHttpSourceRequest";
import { BatcherOptions, WebhookContextMetadata } from "@trigger.dev/core";
import { createHash } from "crypto";
import { ZodWorkerBatchEnqueueOptions } from "~/platform/zodWorker.server";

export class HandleWebhookRequestService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(id: string, request: Request, metadata: WebhookContextMetadata) {
    const webhookEnvironment = await this.#prismaClient.webhookEnvironment.findUnique({
      where: {
        id,
      },
      include: {
        deliveryBatcher: true,
        endpoint: true,
        environment: true,
      },
    });

    if (!webhookEnvironment) {
      return { status: 404 };
    }

    if (!webhookEnvironment.active) {
      return { status: 200 };
    }

    const webhookRequest = await createHttpSourceRequest(request);

    const lockId = webhookIdToLockId(webhookEnvironment.webhookId);

    await this.#prismaClient.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockId})`;

      const counter = await tx.webhookDeliveryCounter.upsert({
        where: { webhookId: webhookEnvironment.id },
        update: { lastNumber: { increment: 1 } },
        create: { webhookId: webhookEnvironment.id, lastNumber: 1 },
        select: { lastNumber: true },
      });

      const delivery = await tx.webhookRequestDelivery.create({
        data: {
          number: counter.lastNumber,
          webhookId: webhookEnvironment.webhookId,
          webhookEnvironmentId: webhookEnvironment.id,
          endpointId: webhookEnvironment.endpointId,
          environmentId: webhookEnvironment.environmentId,
          url: webhookRequest.url,
          method: webhookRequest.method,
          headers: webhookRequest.headers,
          body: webhookRequest.rawBody,
        },
      });

      if (webhookEnvironment.deliveryBatcher) {
        const { maxPayloads, runAt } = this.#getBatchEnqueueOptions(
          webhookEnvironment.deliveryBatcher
        );

        await workerQueue.batchEnqueue("batchWebhookDeliveryRequests", [delivery.id], {
          tx,
          maxAttempts:
            webhookEnvironment.environment.type === RuntimeEnvironmentType.DEVELOPMENT
              ? 1
              : undefined,
          jobKey: webhookEnvironment.id,
          maxPayloads,
          runAt,
        });
      } else {
        await workerQueue.enqueue(
          "deliverWebhookRequest",
          {
            webhookEnvironmentId: webhookEnvironment.id,
            requestDeliveryId: delivery.id,
          },
          {
            tx,
            maxAttempts:
              webhookEnvironment.environment.type === RuntimeEnvironmentType.DEVELOPMENT
                ? 1
                : undefined,
          }
        );
      }
    });

    return { status: 200 };
  }

  #getBatchEnqueueOptions(batcherConfig?: {
    maxPayloads: number | null;
    maxInterval: number | null;
  }): Pick<ZodWorkerBatchEnqueueOptions, "maxPayloads" | "runAt"> {
    const DEFAULT_MAX_PAYLOADS = 500;
    const DEFAULT_MAX_INTERVAL_IN_SECONDS = 10 * 60;

    const MAX_PAYLOADS = DEFAULT_MAX_PAYLOADS;
    const MAX_INTERVAL_IN_SECONDS = DEFAULT_MAX_INTERVAL_IN_SECONDS;

    const maxPayloads = Math.min(batcherConfig?.maxPayloads ?? DEFAULT_MAX_PAYLOADS, MAX_PAYLOADS);

    const runAt = new Date(
      Date.now() +
        Math.min(
          batcherConfig?.maxInterval ?? DEFAULT_MAX_INTERVAL_IN_SECONDS,
          MAX_INTERVAL_IN_SECONDS
        ) *
          1000
    );

    return { maxPayloads, runAt };
  }
}

function webhookIdToLockId(webhookId: string): number {
  // Convert webhookId to a unique lock identifier
  return parseInt(createHash("sha256").update(webhookId).digest("hex").slice(0, 8), 16);
}
