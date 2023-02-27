import { z } from "zod";
import { TriggerWorkflowMessageSchema } from "../schemas/workflows";
import { WorkflowRunEventPropertiesSchema } from "../sharedSchemas";

const Catalog = {
  TRIGGER_WORKFLOW: {
    data: TriggerWorkflowMessageSchema,
    properties: WorkflowRunEventPropertiesSchema.extend({
      "x-ttl": z.coerce.number().optional(),
      "x-is-test": z.string().default("false"),
      "x-app-origin": z.string().default("https://app.trigger.dev"),
      "x-attempt": z.string().optional(),
    }),
  },
};

export default Catalog;
