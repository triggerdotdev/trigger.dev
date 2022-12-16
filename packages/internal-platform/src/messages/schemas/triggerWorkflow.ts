import { z } from "zod";
import { JsonSchema } from "../../schemas";
import { WorkflowEventPropertiesSchema } from "../sharedSchemas";

export const TriggerWorkflowMessageSchema = z.object({
  id: z.string(),
  input: JsonSchema.default({}),
  context: JsonSchema.default({}),
  timestamp: z.string().datetime(),
});

const Catalog = {
  TRIGGER_WORKFLOW: {
    data: TriggerWorkflowMessageSchema,
    properties: WorkflowEventPropertiesSchema,
  },
};

export default Catalog;
