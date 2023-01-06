import { z } from "zod";
import { JsonSchema } from "@trigger.dev/common-schemas";

export const TriggerWorkflowMessageSchema = z.object({
  id: z.string(),
  input: JsonSchema.default({}),
  context: JsonSchema.default({}),
});
