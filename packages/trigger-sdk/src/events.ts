import {
  EventFilterSchema,
  TriggerMetadataSchema,
  ScheduleSourceSchema,
  ScheduledEventPayloadSchema,
} from "@trigger.dev/common-schemas";
import { z } from "zod";

export type EventRule = z.infer<typeof EventFilterSchema>;

export type TriggerEvent<TSchema extends z.ZodTypeAny> = {
  metadata: z.infer<typeof TriggerMetadataSchema>;
  schema: TSchema;
};

export type TriggerCustomEventOptions<TSchema extends z.ZodTypeAny> = {
  name: string;
  schema: TSchema;
};

export function customEvent<TSchema extends z.ZodTypeAny>(
  options: TriggerCustomEventOptions<TSchema>
): TriggerEvent<TSchema> {
  return {
    metadata: {
      type: "CUSTOM_EVENT",
      service: "trigger",
      name: options.name,
      filter: { event: [options.name] },
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
