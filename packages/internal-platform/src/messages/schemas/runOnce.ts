import {
  CompleteRunOnceSchema,
  FetchOutputSchema,
  FetchRequestSchema,
  InitializeRunOnceSchema,
  JsonSchema,
  ResolveRunOnceOuputSchema,
  RetrySchema,
} from "@trigger.dev/common-schemas";
import { z } from "zod";
import {
  WorkflowRunEventPropertiesSchema,
  WorkflowSendRunEventPropertiesSchema,
} from "../sharedSchemas";

export const commandResponses = {
  RESOLVE_RUN_ONCE: {
    data: z.object({
      id: z.string(),
      key: z.string(),
      runOnce: ResolveRunOnceOuputSchema,
    }),
    properties: WorkflowRunEventPropertiesSchema,
  },
};

export const commands = {
  INITIALIZE_RUN_ONCE: {
    data: z.object({
      key: z.string(),
      runOnce: InitializeRunOnceSchema,
    }),
    properties: WorkflowSendRunEventPropertiesSchema,
  },
  COMPLETE_RUN_ONCE: {
    data: z.object({
      key: z.string(),
      runOnce: CompleteRunOnceSchema,
    }),
    properties: WorkflowSendRunEventPropertiesSchema,
  },
};
