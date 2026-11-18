import { ApiDeploymentListParams } from "@trigger.dev/core/v3/schemas";
import { z } from "zod";
import { CommonProjectsInput } from "./common";

const DeployEnvironment = z.enum(["staging", "prod", "preview"]);

export const ListDeploysInput = CommonProjectsInput.omit({
  environment: true,
})
  .extend({
    environment: DeployEnvironment.describe("The environment to list deploys for").default("prod"),
  })
  .extend(ApiDeploymentListParams);

export type ListDeploysInput = z.output<typeof ListDeploysInput>;

export const ListPreviewBranchesInput = CommonProjectsInput.pick({
  projectRef: true,
  configPath: true,
});

export type ListPreviewBranchesInput = z.output<typeof ListPreviewBranchesInput>;
