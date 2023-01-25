import {
  EventFilterSchema,
  TriggerMetadataSchema,
  ScheduleSourceSchema,
  ScheduledEventPayloadSchema,
  EventFilter,
} from "@trigger.dev/common-schemas";
import { z } from "zod";
import slugify from "slug";

export type EventRule = z.infer<typeof EventFilterSchema>;

export type TriggerEvent<TSchema extends z.ZodTypeAny> = {
  metadata: z.infer<typeof TriggerMetadataSchema>;
  schema: TSchema;
};

export type TriggerCustomEventOptions<TSchema extends z.ZodTypeAny> = {
  name: string;
  schema: TSchema;
  filter?: EventFilter;
};

export function customEvent<TSchema extends z.ZodTypeAny>(
  options: TriggerCustomEventOptions<TSchema>
): TriggerEvent<TSchema> {
  return {
    metadata: {
      type: "CUSTOM_EVENT",
      service: "trigger",
      name: options.name,
      filter: { event: [options.name], payload: options.filter ?? {} },
    },
    schema: options.schema,
  };
}

export type TriggerScheduleOptions = z.infer<typeof ScheduleSourceSchema>;

export function scheduleEvent(
  options: TriggerScheduleOptions
): TriggerEvent<typeof ScheduledEventPayloadSchema> {
  return {
    metadata: {
      type: "SCHEDULE",
      service: "scheduler",
      name: "scheduled-event",
      source: options,
    },
    schema: ScheduledEventPayloadSchema,
  };
}

export type TriggerWebhookEventOptions<TSchema extends z.ZodTypeAny> = {
  schema: TSchema;
  service: string;
  eventName: string;
  filter?: EventFilter;
  verifyPayload?: {
    enabled: boolean;
    header: string;
  };
};

export function webhookEvent<TSchema extends z.ZodTypeAny>(
  options: TriggerWebhookEventOptions<TSchema>
): TriggerEvent<TSchema> {
  return {
    metadata: {
      type: "WEBHOOK",
      service: slugify(options.service),
      name: options.eventName,
      filter: {
        service: [slugify(options.service)],
        payload: options.filter ?? {},
        event: [options.eventName],
      },
      source: {
        verifyPayload: options.verifyPayload ?? { enabled: false },
        event: options.eventName,
      },
      manualRegistration: true,
    },
    schema: options.schema,
  };
}
