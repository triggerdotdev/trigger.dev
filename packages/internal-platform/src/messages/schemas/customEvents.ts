import { CustomEventSchema } from "@trigger.dev/common-schemas";
import { z } from "zod";
import { WorkflowSendRunEventPropertiesSchema } from "../sharedSchemas";

export const commands = {
  TRIGGER_CUSTOM_EVENT: {
    data: z.object({
      key: z.string(),
      event: CustomEventSchema,
    }),
    properties: WorkflowSendRunEventPropertiesSchema,
  },
};
