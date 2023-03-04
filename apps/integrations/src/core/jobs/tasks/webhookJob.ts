import { Destination } from ".prisma/client";
import { WebhookEventResult } from "core/webhook/types";
import { getFetch } from "core/fetch/fetchUtilities";
import { prisma } from "db/db.server";
import crypto from "node:crypto";
import { JobHelpers } from "graphile-worker";
import { z } from "zod";
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
      //the jobKey means this job will overwrite any existing job with the same key
      runner.addJob(
        "webhookTask",
        { deliveryId: deliveryRow.id },
        {
          jobKey: deliveryRow.id,
        }
      )
    );

    const jobs = await Promise.all(jobPromises);
    return { deliveries, jobs };
  });
}

const PayloadSchema = z.object({
  deliveryId: z.string(),
});

export async function webhookTask(
  payload: unknown,
  helpers: JobHelpers
): Promise<void> {
  const { deliveryId } = PayloadSchema.parse(payload);
  const delivery = await prisma.webhookEventDelivery.findUnique({
    where: { id: deliveryId },
    include: {
      destination: {
        include: {
          webhook: true,
        },
      },
    },
  });

  if (!delivery) {
    throw new Error(`Delivery ${deliveryId} not found`);
  }

  const fetch = await getFetch();

  const bodyText = JSON.stringify(delivery.payload);
  const hash = crypto
    .createHmac("sha256", delivery.destination.destinationSecret)
    .update(Buffer.from(bodyText, "utf8"))
    .digest("base64");

  const response = await fetch(delivery.destination.destinationUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Webhook-Signature": `sha256=${hash}`,
    },
    body: bodyText,
  });

  if (!response.ok) {
    throw new Error(
      `Delivery ${deliveryId} failed with status ${response.status}`
    );
  }
}
