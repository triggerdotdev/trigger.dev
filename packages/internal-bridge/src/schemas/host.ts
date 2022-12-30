import { z } from "zod";
import { JsonSchema } from "@trigger.dev/common-schemas";

export const HostRPCSchema = {
  TRIGGER_WORKFLOW: {
    request: z.object({
      id: z.string(),
      trigger: z.object({
        input: JsonSchema.default({}),
        context: JsonSchema.default({}),
      }),
      meta: z.object({
        environment: z.string(),
        workflowId: z.string(),
        organizationId: z.string(),
        apiKey: z.string(),
      }),
    }),
    response: z.void().nullable(),
  },
  COMPLETE_REQUEST: {
    request: z.object({
      id: z.string(),
      output: JsonSchema.default({}),
      meta: z.object({
        environment: z.string(),
        workflowId: z.string(),
        organizationId: z.string(),
        apiKey: z.string(),
        runId: z.string(),
      }),
    }),
    response: z.boolean(),
  },
};

export type HostRPC = typeof HostRPCSchema;
