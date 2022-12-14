import { z } from "zod";
import { MessageCatalogSchema } from "../messageCatalogSchema";
import { WorkflowEventPropertiesSchema } from "../sharedSchemas";

export const TriggerWorkflowMessageSchema = z.object({
  id: z.string(),
  event: z.unknown().optional(),
});

const Catalog = {
  TRIGGER_WORKFLOW: {
    data: TriggerWorkflowMessageSchema,
    properties: WorkflowEventPropertiesSchema,
  },
};

export default Catalog;
