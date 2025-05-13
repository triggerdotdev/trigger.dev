import { z } from "zod";

export const AgentLoopMetadata = z.object({
  waitToken: z.object({
    id: z.string(),
    publicAccessToken: z.string(),
  }),
});

export type AgentLoopMetadata = z.infer<typeof AgentLoopMetadata>;

export const QueryApproval = z.object({
  approved: z.boolean().describe("Whether the query has been approved"),
});

export type QueryApproval = z.infer<typeof QueryApproval>;
