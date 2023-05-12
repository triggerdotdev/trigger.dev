import { z } from "zod";
import { EventFilterSchema, EventRuleSchema } from "./eventFilter";
import { DisplayElementSchema } from "./elements";

export const EventSpecificationSchema = z.object({
  name: z.string(),
  title: z.string(),
  source: z.string(),
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

export const TriggerMetadataSchema = z.discriminatedUnion("type", [
  DynamicTriggerMetadataSchema,
  StaticTriggerMetadataSchema,
]);

export type TriggerMetadata = z.infer<typeof TriggerMetadataSchema>;
