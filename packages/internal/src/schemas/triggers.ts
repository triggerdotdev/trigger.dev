import { z } from "zod";
import { ConnectionMetadataSchema } from "./connections";
import { EventRuleSchema } from "./eventFilter";
import { DeserializedJsonSchema } from "./json";

export const TriggerMetadataSchema = z.object({
  title: z.string(),
  elements: z.array(
    z.object({
      label: z.string(),
      text: z.string(),
      url: z.string().optional(),
    })
  ),
  eventRule: EventRuleSchema,
  schema: DeserializedJsonSchema.optional(),
  connection: z
    .object({
      metadata: ConnectionMetadataSchema,
      usesLocalAuth: z.boolean(),
      id: z.string().optional(),
    })
    .optional(),
});

export type TriggerMetadata = z.infer<typeof TriggerMetadataSchema>;
