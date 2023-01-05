import { z } from "zod";
import { CustomEventSchema } from "@trigger.dev/common-schemas";
import { WorkflowRunEventPropertiesSchema } from "../sharedSchemas";

export const wss = {
  TRIGGER_CUSTOM_EVENT: {
    data: z.object({
      key: z.string(),
      event: CustomEventSchema,
    }),
    properties: WorkflowRunEventPropertiesSchema,
  },
};
