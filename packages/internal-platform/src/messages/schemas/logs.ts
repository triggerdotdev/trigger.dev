import { LogMessageSchema } from "@trigger.dev/common-schemas";
import { z } from "zod";

export const coordinator = {
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
