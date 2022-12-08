import { z } from "zod";

export const ServerRPCSchema = {
  SEND_LOG: {
    request: z.object({
      id: z.string(),
      data: z.string(),
      index: z.number().optional(),
      timestamp: z.number().optional(),
    }),
    response: z.boolean(),
  },
  INITIALIZE_HOST: {
    request: z.object({
      apiKey: z.string(),
      workflowId: z.string(),
      workflowName: z.string(),
      triggerId: z.string(),
      packageVersion: z.string(),
      packageName: z.string(),
    }),
    response: z
      .discriminatedUnion("type", [
        z.object({
          type: z.literal("success"),
        }),
        z.object({
          type: z.literal("error"),
          message: z.string(),
        }),
      ])
      .nullable(),
  },
};

export type ServerRPC = typeof ServerRPCSchema;
