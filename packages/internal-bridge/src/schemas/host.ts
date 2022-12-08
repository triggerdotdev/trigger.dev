import { z } from "zod";
import { TriggerEnvironmentSchema } from "./common";

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
      triggerId: z.string(),
      data: z.any(),
      environment: TriggerEnvironmentSchema,
    }),
    response: z.void().nullable(),
  },
};

export type HostRPC = typeof HostRPCSchema;
