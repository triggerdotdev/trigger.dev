import type { CustomEventSchema } from "@trigger.dev/common-schemas";
import type { PublishOptions } from "internal-platform";
import { ulid } from "ulid";
import type { z } from "zod";
import { taskQueue } from "~/services/messageBroker.server";
import { omit } from "~/utils/objects";
import { IngestEvent } from "./ingest.server";

export type IngestCustomEventOptions = {
  id?: string;
  apiKey: string;
  event: z.infer<typeof CustomEventSchema>;
  isTest?: boolean;
};

export class IngestCustomEvent {
  public async call(options: IngestCustomEventOptions) {
    if (options.event.delay) {
      const deliveryOptions: PublishOptions =
        "until" in options.event.delay
          ? { deliverAt: new Date(options.event.delay.until).getTime() }
          : "seconds" in options.event.delay
          ? { deliverAfter: options.event.delay.seconds * 1000 }
          : "minutes" in options.event.delay
          ? { deliverAfter: options.event.delay.minutes * 60 * 1000 }
          : "hours" in options.event.delay
          ? { deliverAfter: options.event.delay.hours * 60 * 60 * 1000 }
          : "days" in options.event.delay
          ? { deliverAfter: options.event.delay.days * 60 * 60 * 24 * 1000 }
          : { deliverAfter: 0 };

      await taskQueue.publish(
        "INGEST_DELAYED_EVENT",
        {
          id: options.id,
          apiKey: options.apiKey,
          event: omit(options.event, ["delay"]),
        },
        {},
        deliveryOptions
      );

      return;
    }

    const ingestService = new IngestEvent();

    await ingestService.call({
      id: options.id ?? ulid(),
      name: options.event.name,
      type: "CUSTOM_EVENT",
      service: "trigger",
      payload: options.event.payload,
      context: options.event.context,
      timestamp: options.event.timestamp,
      apiKey: options.apiKey,
      isTest: options.isTest,
    });
  }
}
