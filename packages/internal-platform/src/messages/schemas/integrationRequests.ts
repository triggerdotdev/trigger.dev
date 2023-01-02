import { JsonSchema } from "@trigger.dev/common-schemas";
import { z } from "zod";
import {
  WorkflowRunEventPropertiesSchema,
  WorkflowSendRunEventPropertiesSchema,
} from "../sharedSchemas";

export const platform = {
  RESOLVE_INTEGRATION_REQUEST: {
    data: z.object({
      id: z.string(),
      output: JsonSchema.default({}),
    }),
    properties: WorkflowRunEventPropertiesSchema,
  },
};

export const coordinator = {
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
