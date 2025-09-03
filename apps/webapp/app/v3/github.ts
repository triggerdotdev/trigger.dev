import { z } from "zod";

export const BranchTrackingConfigSchema = z.object({
  prod: z.object({
    branch: z.string().optional(),
  }),
  staging: z.object({
    branch: z.string().optional(),
  }),
});

export type BranchTrackingConfig = z.infer<typeof BranchTrackingConfigSchema>;

export function getTrackedBranchForEnvironment(
  branchTracking: BranchTrackingConfig | undefined,
  environmentType: "PRODUCTION" | "STAGING" | "DEVELOPMENT" | "PREVIEW"
): string | undefined {
  if (!branchTracking) return undefined;
  switch (environmentType) {
    case "PRODUCTION":
      return branchTracking.prod?.branch;
    case "STAGING":
      return branchTracking.staging?.branch;
    default:
      return undefined;
  }
}
