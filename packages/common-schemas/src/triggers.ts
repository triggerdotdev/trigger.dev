import { z } from "zod";
import {
  EventFilterSchema,
  ScheduleSourceSchema,
  SlackInteractionSourceSchema,
} from "./events";
import { JsonSchema } from "./json";

export const CustomEventTriggerSchema = z.object({
  type: z.literal("CUSTOM_EVENT"),
  service: z.literal("trigger"),
  name: z.string(),
  filter: EventFilterSchema,
  schema: JsonSchema.optional(),
});
export type CustomEventTrigger = z.infer<typeof CustomEventTriggerSchema>;

export const WebhookEventTriggerSchema = z.object({
  type: z.literal("WEBHOOK"),
  service: z.string(),
  name: z.string(),
  filter: EventFilterSchema,
  source: JsonSchema.optional(),
  manualRegistration: z.boolean().default(false),
  schema: JsonSchema.optional(),
});
export type WebhookEventTrigger = z.infer<typeof WebhookEventTriggerSchema>;

export const HttpEventTriggerSchema = z.object({
  type: z.literal("HTTP_ENDPOINT"),
  service: z.literal("trigger"),
  name: z.string(),
  filter: EventFilterSchema,
});
export type HttpEventTrigger = z.infer<typeof HttpEventTriggerSchema>;

export const ScheduledEventTriggerSchema = z.object({
  type: z.literal("SCHEDULE"),
  service: z.literal("scheduler"),
  name: z.string(),
  source: ScheduleSourceSchema,
});
export type ScheduledEventTrigger = z.infer<typeof ScheduledEventTriggerSchema>;

export const SlackInteractionTriggerSchema = z.object({
  type: z.literal("SLACK_INTERACTION"),
  service: z.literal("slack"),
  name: z.string(),
  filter: EventFilterSchema,
  source: SlackInteractionSourceSchema,
});
export type SlackInteractionEventTrigger = z.infer<
  typeof SlackInteractionTriggerSchema
>;

export const TriggerMetadataSchema = z.discriminatedUnion("type", [
  CustomEventTriggerSchema,
  WebhookEventTriggerSchema,
  HttpEventTriggerSchema,
  ScheduledEventTriggerSchema,
  SlackInteractionTriggerSchema,
]);

export type TriggerMetadata = z.infer<typeof TriggerMetadataSchema>;
