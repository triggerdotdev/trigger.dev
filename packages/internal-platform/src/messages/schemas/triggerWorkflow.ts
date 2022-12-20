import { z } from "zod";
import { JsonSchema } from "@trigger.dev/common-schemas";
import { WorkflowEventPropertiesSchema } from "../sharedSchemas";

export const TriggerWorkflowMessageSchema = z.object({
  id: z.string(),
  input: JsonSchema.default({}),
  context: JsonSchema.default({}),
});

const Catalog = {
  TRIGGER_WORKFLOW: {
    data: TriggerWorkflowMessageSchema,
    properties: WorkflowEventPropertiesSchema,
  },
};

export default Catalog;
