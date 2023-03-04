import { Destination } from ".prisma/client";
import { WebhookEventResult } from "core/webhook/types";
import { prisma } from "db/db.server";
import { JobHelpers } from "graphile-worker";
import { runner } from "../worker";

export async function createDeliveriesAndTasks({
  eventResults,
  destinations,
}: {
  eventResults: WebhookEventResult[];
  destinations: Destination[];
}) {
  const deliveries = eventResults.flatMap((eventResult) => {
    const matchingDestinations = destinations.filter(
      (d) => d.destinationEvent === eventResult.event
    );

    return matchingDestinations.map((destination) => ({
      eventName: eventResult.event,
      destinationId: destination.id,
      payload: eventResult.payload,
    }));
  });

  return await prisma.$transaction(async (tx) => {
    const deliveryPromises = deliveries.map((delivery) =>
      tx.webhookEventDelivery.create({
        data: {
          eventName: delivery.eventName,
          destinationId: delivery.destinationId,
          payload: delivery.payload,
        },
      })
    );

    const deliveryRows = await Promise.all(deliveryPromises);
    const jobPromises = deliveryRows.map((deliveryRow) =>
      runner.addJob("webhookTask", { deliveryId: deliveryRow.id })
    );

    const jobs = await Promise.all(jobPromises);
    return { deliveries, jobs };
  });
}

export async function webhookTask(
  payload: unknown,
  helpers: JobHelpers
): Promise<void> {
  // const { name } = payload;
  // helpers.logger.info(`Hello, ${name}`);

  console.log("webhookTask", payload);
  throw new Error("Not implemented");
}
