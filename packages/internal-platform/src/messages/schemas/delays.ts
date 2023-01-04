import { WaitSchema } from "@trigger.dev/common-schemas";
import { z } from "zod";
import {
  WorkflowRunEventPropertiesSchema,
  WorkflowSendRunEventPropertiesSchema,
} from "../sharedSchemas";

export const coordinator = {
  INITIALIZE_DELAY: {
    data: z.object({
      key: z.string(),
      wait: WaitSchema,
    }),
    properties: WorkflowSendRunEventPropertiesSchema,
  },
};

export const platform = {
  RESOLVE_DELAY: {
    data: z.object({
      id: z.string(),
      key: z.string(),
    }),
    properties: WorkflowRunEventPropertiesSchema,
  },
};
