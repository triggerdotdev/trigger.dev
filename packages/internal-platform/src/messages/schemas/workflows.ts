import { z } from "zod";
import { JsonSchema } from "@trigger.dev/common-schemas";
import { WorkflowRunEventPropertiesSchema } from "../sharedSchemas";

export const TriggerWorkflowMessageSchema = z.object({
  id: z.string(),
  input: JsonSchema.default({}),
  context: JsonSchema.default({}),
});

export const platform = {
  TRIGGER_WORKFLOW: {
    data: TriggerWorkflowMessageSchema,
    properties: WorkflowRunEventPropertiesSchema,
  },
};
