import { LogMessageSchema } from "@trigger.dev/common-schemas";
import { z } from "zod";
import { WorkflowSendRunEventPropertiesSchema } from "../sharedSchemas";

export const wss = {
  LOG_MESSAGE: {
    data: z.object({
      key: z.string(),
      log: LogMessageSchema,
    }),
    properties: WorkflowSendRunEventPropertiesSchema,
  },
};
