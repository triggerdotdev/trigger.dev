import { z } from "zod";
import { EventFilterSchema, EventRuleSchema } from "./eventFilter";
import { DisplayPropertySchema } from "./properties";
import { ScheduleMetadataSchema } from "./schedules";

export const EventExampleSchema = z.object({
  id: z.string(),
  icon: z.string().optional(),
  name: z.string(),
  payload: z.any(),
});

export type EventExample = z.infer<typeof EventExampleSchema>;

export const EventSpecificationSchema = z.object({
  name: z.string(),
  title: z.string(),
  source: z.string(),
  icon: z.string(),
  filter: EventFilterSchema.optional(),
  properties: z.array(DisplayPropertySchema).optional(),
  schema: z.any().optional(),
  examples: z.array(EventExampleSchema).optional(),
});

export const DynamicTriggerMetadataSchema = z.object({
  type: z.literal("dynamic"),
  id: z.string(),
});

export const StaticTriggerMetadataSchema = z.object({
  type: z.literal("static"),
  title: z.string(),
  properties: z.array(DisplayPropertySchema).optional(),
  rule: EventRuleSchema,
});

export const ScheduledTriggerMetadataSchema = z.object({
  type: z.literal("scheduled"),
  schedule: ScheduleMetadataSchema,
});

export const TriggerMetadataSchema = z.discriminatedUnion("type", [
  DynamicTriggerMetadataSchema,
  StaticTriggerMetadataSchema,
  ScheduledTriggerMetadataSchema,
]);

export type TriggerMetadata = z.infer<typeof TriggerMetadataSchema>;
