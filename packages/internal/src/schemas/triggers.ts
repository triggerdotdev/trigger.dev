import { z } from "zod";
import { DeserializedJsonSchema } from "./json";

export const TriggerMetadataSchema = z.object({
  title: z.string(),
  source: z.string(),
  displayProperties: z.array(
    z.object({
      label: z.string(),
      value: z.string(),
    })
  ),
  schema: DeserializedJsonSchema.optional(),
});

export type TriggerMetadata = z.infer<typeof TriggerMetadataSchema>;
