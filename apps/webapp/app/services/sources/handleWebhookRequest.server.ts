import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { workerQueue } from "../worker.server";
import { createHttpSourceRequest } from "~/utils/createHttpSourceRequest";
import { WebhookContextMetadata } from "@trigger.dev/core";
import { createHash } from "node:crypto";
import { RuntimeEnvironmentType } from "~/database-types";

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

      await workerQueue.enqueue(
        "deliverWebhookRequest",
        {
          id: delivery.id,
        },
        {
          tx,
          maxAttempts:
            webhookEnvironment.environment.type === RuntimeEnvironmentType.DEVELOPMENT
              ? 1
              : undefined,
        }
      );
    });

    return { status: 200 };
  }
}

function webhookIdToLockId(webhookId: string): number {
  // Convert webhookId to a unique lock identifier
  return parseInt(createHash("sha256").update(webhookId).digest("hex").slice(0, 8), 16);
}
