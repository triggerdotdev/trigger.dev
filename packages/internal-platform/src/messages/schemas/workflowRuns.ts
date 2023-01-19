import { ErrorSchema } from "@trigger.dev/common-schemas";
import { z } from "zod";
import { WorkflowSendRunEventPropertiesSchema } from "../sharedSchemas";

export const commands = {
  WORKFLOW_RUN_COMPLETE: {
    data: z.object({
      output: z.string().optional(),
    }),
    properties: WorkflowSendRunEventPropertiesSchema,
  },
  WORKFLOW_RUN_ERROR: {
    data: z.object({
      error: ErrorSchema,
    }),
    properties: WorkflowSendRunEventPropertiesSchema,
  },
  WORKFLOW_RUN_STARTED: {
    data: z.object({
      id: z.string(),
    }),
    properties: WorkflowSendRunEventPropertiesSchema,
  },
  WORKFLOW_RUN_DISCONNECTED: {
    data: z.object({
      id: z.string(),
    }),
    properties: WorkflowSendRunEventPropertiesSchema,
  },
};
