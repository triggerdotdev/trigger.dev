import { z } from "zod";

export const WarmStartConnectResponse = z.object({
  connectionTimeoutMs: z.number().optional(),
  keepaliveMs: z.number().optional(),
});

export type WarmStartConnectResponse = z.infer<typeof WarmStartConnectResponse>;
