import { LogMessageSchema } from "@trigger.dev/common-schemas";
import { z } from "zod";

const Catalog = {
  LOG_MESSAGE: {
    data: z.object({
      id: z.string(),
      log: LogMessageSchema,
    }),
    properties: z.object({
      "x-workflow-id": z.string(),
      "x-api-key": z.string(),
    }),
  },
};

export default Catalog;
