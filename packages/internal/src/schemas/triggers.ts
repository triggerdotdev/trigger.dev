import { z } from "zod";
import { EventFilterSchema, EventRuleSchema } from "./eventFilter";
import { DisplayElementSchema } from "./elements";
import { ScheduleMetadataSchema } from "./schedules";

export const EventSpecificationSchema = z.object({
  name: z.string(),
  title: z.string(),
  source: z.string(),
  icon: z.string(),
  filter: EventFilterSchema.optional(),
  elements: z.array(DisplayElementSchema).optional(),
  schema: z.any().optional(),
  examples: z.array(z.any()).optional(),
});

export const DynamicTriggerMetadataSchema = z.object({
  type: z.literal("dynamic"),
  id: z.string(),
});

export const StaticTriggerMetadataSchema = z.object({
  type: z.literal("static"),
  title: z.string(),
  elements: z.array(DisplayElementSchema).optional(),
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
