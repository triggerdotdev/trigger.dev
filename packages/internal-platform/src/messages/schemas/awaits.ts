import { WaitSchema } from "@trigger.dev/common-schemas";
import { z } from "zod";
import { WorkflowSendRunEventPropertiesSchema } from "../sharedSchemas";

const Catalog = {
  INITIALIZE_DELAY: {
    data: z.object({
      id: z.string(),
      delay: z.number(),
    }),
    properties: WorkflowSendRunEventPropertiesSchema,
  },
};

export default Catalog;
