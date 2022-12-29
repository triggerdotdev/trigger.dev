import { z } from "zod";
import { WorkflowSendRunEventPropertiesSchema } from "../sharedSchemas";

const Catalog = {
  SEND_INTEGRATION_REQUEST: {
    data: z.object({
      id: z.string(),
      service: z.string(),
      endpoint: z.string(),
      params: z.any(),
    }),
    properties: WorkflowSendRunEventPropertiesSchema,
  },
};

export default Catalog;
