import { prisma ,type  PrismaClient  } from "~/db.server";
import { workerQueue } from "../worker.server";
import { createHttpSourceRequest } from "~/utils/createHttpSourceRequest";
import { RuntimeEnvironmentType } from "~/database-types";

export class HandleHttpSourceService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(id: string, request: Request) {
    const triggerSource = await this.#prismaClient.triggerSource.findUnique({
      where: { id },
      include: {
        endpoint: true,
        environment: true,
        secretReference: true,
        organization: true,
      },
    });

    if (!triggerSource) {
      return { status: 404 };
    }

    if (!triggerSource.active) {
      return { status: 200 };
    }

    if (!triggerSource.endpoint.url) {
      return { status: 404 };
    }

    if (!triggerSource.organization.runsEnabled) {
      return { status: 404 };
    }

    if (!triggerSource.interactive) {
      const sourceRequest = await createHttpSourceRequest(request);

      await this.#prismaClient.$transaction(async (tx) => {
        // Create a request delivery and then enqueue it to be delivered
        const delivery = await tx.httpSourceRequestDelivery.create({
          data: {
            sourceId: triggerSource.id,
            endpointId: triggerSource.endpointId,
            environmentId: triggerSource.environmentId,
            url: sourceRequest.url,
            method: sourceRequest.method,
            headers: sourceRequest.headers,
            body: sourceRequest.rawBody,
          },
        });

        await workerQueue.enqueue(
          "deliverHttpSourceRequest",
          {
            id: delivery.id,
          },
          {
            tx,
            maxAttempts:
              triggerSource.environment.type === RuntimeEnvironmentType.DEVELOPMENT ? 1 : undefined,
          }
        );
      });

      return { status: 200 };
    }

    // TODO: implement interactive webhooks

    return { status: 200 };
  }
}
