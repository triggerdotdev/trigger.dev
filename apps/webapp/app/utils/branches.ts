import { GitMeta } from "@trigger.dev/core/v3";
import { z } from "zod";

/**
 * Shared zod schemas for the branch list/create surfaces. Kept in a non-route
 * module so services (`upsertBranch.server`) and presenters (`BranchesPresenter`)
 * can consume them without importing from a route, and so the preview and dev
 * branch routes don't each redefine them.
 */

/** Search/filter params for the branches list pages. */
export const BranchesOptions = z.object({
  search: z.string().optional(),
  showArchived: z.preprocess((val) => val === "true" || val === true, z.boolean()).optional(),
  page: z.preprocess((val) => Number(val), z.number()).optional(),
});

/** Payload accepted by the create-branch service/action. */
export const CreateBranchOptions = z.object({
  projectId: z.string(),
  env: z.enum(["preview", "development"]),
  branchName: z.string().min(1),
  git: GitMeta.optional(),
});

/** The create-branch form schema (payload + the form's failure redirect path). */
export const CreateBranchFormSchema = CreateBranchOptions.and(
  z.object({
    failurePath: z.string(),
  })
);
