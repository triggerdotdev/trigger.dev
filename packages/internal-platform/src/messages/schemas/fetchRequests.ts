import {
  FetchOutputSchema,
  FetchRequestSchema,
  JsonSchema,
  RetrySchema,
} from "@trigger.dev/common-schemas";
import { z } from "zod";
import {
  WorkflowRunEventPropertiesSchema,
  WorkflowSendRunEventPropertiesSchema,
} from "../sharedSchemas";

export const commandResponses = {
  RESOLVE_FETCH_REQUEST: {
    data: z.object({
      id: z.string(),
      key: z.string(),
      output: FetchOutputSchema,
    }),
    properties: WorkflowRunEventPropertiesSchema,
  },
  REJECT_FETCH_REQUEST: {
    data: z.object({
      id: z.string(),
      key: z.string(),
      error: JsonSchema.default({}),
    }),
    properties: WorkflowRunEventPropertiesSchema,
  },
};

export const commands = {
  SEND_FETCH_REQUEST: {
    data: z.object({
      key: z.string(),
      fetch: FetchRequestSchema,
    }),
    properties: WorkflowSendRunEventPropertiesSchema,
  },
};
