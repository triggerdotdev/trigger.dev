import { z } from "zod";
import { TriggerEnvironmentSchema } from "./common";
import { JsonSchema } from "@trigger.dev/common-schemas";

export const HostRPCSchema = {
  IO_RESPONSE: {
    request: z.object({
      value: z.string(),
      transactionId: z.string(),
    }),
    response: z.void().nullable(),
  },
  TRIGGER_WORKFLOW: {
    request: z.object({
      id: z.string(),
      trigger: z.object({
        input: JsonSchema.default({}),
        context: JsonSchema.default({}),
        timestamp: z.string().datetime(),
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
};

export type HostRPC = typeof HostRPCSchema;
