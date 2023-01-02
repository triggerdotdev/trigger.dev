import { z } from "zod";
import { CustomEventSchema } from "@trigger.dev/common-schemas";

export const coordinator = {
  TRIGGER_CUSTOM_EVENT: {
    data: z.object({
      id: z.string(),
      event: CustomEventSchema,
    }),
    properties: z.object({
      "x-workflow-id": z.string(),
      "x-api-key": z.string(),
    }),
  },
};
