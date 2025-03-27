import { z } from "zod";

export const AgentLoopMetadata = z.object({
  waitToken: z.object({
    id: z.string(),
    publicAccessToken: z.string(),
  }),
});

export type AgentLoopMetadata = z.infer<typeof AgentLoopMetadata>;
