import { z } from "zod";

export const WarmStartConnectResponse = z.object({
  connectionTimeoutMs: z.number().optional(),
  totalWarmStartDurationMs: z.number().optional(),
});

export type WarmStartConnectResponse = z.infer<typeof WarmStartConnectResponse>;
