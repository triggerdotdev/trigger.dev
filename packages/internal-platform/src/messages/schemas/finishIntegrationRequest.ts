import { JsonSchema } from "@trigger.dev/common-schemas";
import { z } from "zod";
import { WorkflowRunEventPropertiesSchema } from "../sharedSchemas";

const Catalog = {
  RESOLVE_INTEGRATION_REQUEST: {
    data: z.object({
      id: z.string(),
      output: JsonSchema.default({}),
    }),
    properties: WorkflowRunEventPropertiesSchema,
  },
};

export default Catalog;
