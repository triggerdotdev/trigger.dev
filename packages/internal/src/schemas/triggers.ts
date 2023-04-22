import { z } from "zod";
import { ConnectionMetadataSchema } from "./connections";
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
  schema: DeserializedJsonSchema.optional(),
  connection: z
    .object({
      metadata: ConnectionMetadataSchema,
      hasLocalAuth: z.boolean().default(false),
    })
    .optional(),
});

export type TriggerMetadata = z.infer<typeof TriggerMetadataSchema>;
