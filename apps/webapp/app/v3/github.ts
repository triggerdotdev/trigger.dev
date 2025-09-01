import { z } from "zod";

export const BranchTrackingConfigSchema = z.object({
  production: z.object({
    branch: z.string(),
  }),
  staging: z.object({
    branch: z.string(),
  }),
});

export type BranchTrackingConfig = z.infer<typeof BranchTrackingConfigSchema>;
