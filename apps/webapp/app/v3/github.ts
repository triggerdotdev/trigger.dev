import { z } from "zod";

export const BranchTrackingConfigSchema = z.object({
  production: z.object({
    branch: z.string().optional(),
  }),
  staging: z.object({
    branch: z.string().optional(),
  }),
});

export type BranchTrackingConfig = z.infer<typeof BranchTrackingConfigSchema>;
