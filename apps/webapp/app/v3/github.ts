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
  previewDeploymentsEnabled: boolean,
  environment: {
    type: "PRODUCTION" | "STAGING" | "DEVELOPMENT" | "PREVIEW";
    branchName?: string;
  }
): string | undefined {
  if (!branchTracking) return undefined;
  switch (environment.type) {
    case "PRODUCTION":
      return branchTracking.prod?.branch;
    case "STAGING":
      return branchTracking.staging?.branch;
    case "PREVIEW":
      return previewDeploymentsEnabled ? environment.branchName : undefined;
    case "DEVELOPMENT":
      return undefined;
    default:
      return environment.type satisfies never;
  }
}
