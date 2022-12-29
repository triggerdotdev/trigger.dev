import { z } from "zod";
import { WorkflowRunEventPropertiesSchema } from "../sharedSchemas";

const Catalog = {
  FINISH_INTEGRATION_REQUEST: {
    data: z.object({
      id: z.string(),
      status: z.enum(["SUCCESS", "FAILURE"]),
      response: z.object({
        status: z.number(),
        headers: z.record(z.string()),
        body: z.string().optional(),
      }),
    }),
    properties: WorkflowRunEventPropertiesSchema,
  },
};

export default Catalog;
