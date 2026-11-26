import { z } from "zod";
import { CommonProjectsInput } from "./common";

const ProjectInput = CommonProjectsInput.pick({ projectRef: true, configPath: true });

const BranchName = z
  .string()
  .min(1)
  .max(255)
  .describe("The branch name, as shown by list_branches.");

export const ListEnvironmentsInput = ProjectInput;

export const ListRegionsInput = ProjectInput;

const BranchParent = z
  .enum(["preview", "dev"])
  .describe("preview for a preview branch, dev for a branch of your own dev environment.");

export const ListBranchesInput = ProjectInput.extend({
  environment: BranchParent.describe("preview branches, or dev for your own dev branches."),
  search: z.string().max(255).describe("Only branches whose name contains this text.").optional(),
  showArchived: z.boolean().describe("Include archived branches.").optional(),
  page: z.number().int().min(1).max(10_000).describe("The page to return, from 1.").optional(),
});

export const DeploymentWriteInput = ProjectInput.extend({
  environment: z
    .enum(["staging", "prod", "preview"])
    .describe("The environment the deployment belongs to."),
  branch: BranchName.describe("The preview branch the deployment belongs to.").optional(),
  shortCode: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/, "A short code has 1 to 64 letters, digits, - or _")
    .describe("The deployment's short code, as shown by list_deploys."),
});

export const CreateBranchInput = ProjectInput.extend({
  environment: BranchParent,
  branchName: BranchName.describe("The git branch name for the new branch."),
});

export const ArchiveBranchInput = ProjectInput.extend({
  environment: BranchParent,
  branchName: BranchName,
});

export const SetAutoArchiveInput = ProjectInput.extend({
  days: z
    .number()
    .int()
    .min(1)
    .max(365)
    .nullable()
    .describe(
      "Archive preview branches this many days after their last deployment (or creation). null turns automatic archiving off."
    ),
  excludedBranches: z
    .array(z.string().min(1).max(255))
    .max(100)
    .describe("Branch names that are never archived automatically. Replaces the current list.")
    .optional(),
});

export const SetDefaultRegionInput = ProjectInput.extend({
  region: z.string().min(1).max(128).describe("The region name, as shown by list_regions."),
});
