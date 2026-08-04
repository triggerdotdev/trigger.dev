import { z } from "zod/v4";

export const WarmStartConnectResponse = z.object({
  connectionTimeoutMs: z.number().optional(),
  keepaliveMs: z.number().optional(),
});

export type WarmStartConnectResponse = z.infer<typeof WarmStartConnectResponse>;
