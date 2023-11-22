import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { workerQueue } from "../worker.server";
import { RuntimeEnvironmentType } from "@trigger.dev/database";
import { createHttpSourceRequest } from "~/utils/createHttpSourceRequest";
import { WebhookContextMetadata } from "@trigger.dev/core";

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

    await this.#prismaClient.$transaction(async (tx) => {
      const delivery = await tx.webhookRequestDelivery.create({
        data: {
          webhookId: webhookEnvironment.webhookId,
          webhookEnvironmentId: webhookEnvironment.id,
          endpointId: webhookEnvironment.endpointId,
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
          queueName: `deliver:${webhookEnvironment.id}`,
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
