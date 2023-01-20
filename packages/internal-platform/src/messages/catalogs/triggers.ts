import { z } from "zod";
import { TriggerWorkflowMessageSchema } from "../schemas/workflows";
import { WorkflowRunEventPropertiesSchema } from "../sharedSchemas";

const Catalog = {
  TRIGGER_WORKFLOW: {
    data: TriggerWorkflowMessageSchema,
    properties: WorkflowRunEventPropertiesSchema.extend({
      "x-ttl": z.coerce.number().optional(),
    }),
  },
};

export default Catalog;
