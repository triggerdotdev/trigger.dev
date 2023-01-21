import { z } from "zod";
import { FetchOutputSchema, JsonSchema } from "@trigger.dev/common-schemas";

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
    response: z.boolean(),
  },
  RESOLVE_REQUEST: {
    request: z.object({
      id: z.string(),
      key: z.string(),
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
  RESOLVE_DELAY: {
    request: z.object({
      id: z.string(),
      key: z.string(),
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
  REJECT_REQUEST: {
    request: z.object({
      id: z.string(),
      key: z.string(),
      error: JsonSchema.default({}),
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
  RESOLVE_FETCH_REQUEST: {
    request: z.object({
      id: z.string(),
      key: z.string(),
      output: FetchOutputSchema,
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
  REJECT_FETCH_REQUEST: {
    request: z.object({
      id: z.string(),
      key: z.string(),
      error: JsonSchema.default({}),
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
