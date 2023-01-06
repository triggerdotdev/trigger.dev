import { TriggerWorkflowMessageSchema } from "../schemas/workflows";
import { WorkflowRunEventPropertiesSchema } from "../sharedSchemas";

const Catalog = {
  TRIGGER_WORKFLOW: {
    data: TriggerWorkflowMessageSchema,
    properties: WorkflowRunEventPropertiesSchema,
  },
};

export default Catalog;
