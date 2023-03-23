import {
  EventFilterSchema,
  TriggerMetadataSchema,
  ScheduleSourceSchema,
  ScheduledEventPayloadSchema,
} from "@trigger.dev/common-schemas";
import type {
  CustomEventTrigger,
  EventFilter,
  WebhookEventTrigger,
} from "@trigger.dev/common-schemas";
import { z } from "zod";
import slugify from "slug";
import zodToJsonSchema from "zod-to-json-schema";

export type EventRule = z.infer<typeof EventFilterSchema>;

export type TriggerEvent<TEventType = any> = {
  metadata: z.infer<typeof TriggerMetadataSchema>;
};

export type TriggerCustomEventOptions<TSchema extends z.ZodTypeAny> = {
  name: string;
  schema?: TSchema;
  filter?: EventFilter;
};

export function customEvent<TSchema extends z.ZodTypeAny>(
  options: TriggerCustomEventOptions<TSchema>
): TriggerEvent<TSchema> {
  const schema = options.schema ?? z.any();

  return {
    metadata: {
      type: "CUSTOM_EVENT",
      service: "trigger",
      name: options.name,
      filter: { event: [options.name], payload: options.filter ?? {} },
      schema: zodToJsonSchema(schema) as CustomEventTrigger["schema"],
    },
    // @ts-ignore
    schema,
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
  };
}

export type TriggerWebhookEventOptions<TSchema extends z.ZodTypeAny> = {
  schema?: TSchema;
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
  const schema = options.schema ?? z.any();

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
      schema: zodToJsonSchema(schema) as WebhookEventTrigger["schema"],
    },
    // @ts-ignore
    schema,
  };
}
