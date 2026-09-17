import { z } from "zod";
import { isValidGitBranchName } from "@trigger.dev/core/v3/utils/gitBranch";

export const PreviewAutoArchivePolicy = z.object({
  days: z.number().int().min(1).max(365).nullable(),
  excludedBranches: z
    .array(z.string().max(255).refine(isValidGitBranchName, "Invalid branch name"))
    .max(100)
    .transform((names) => [...new Set(names)]),
});

export const PREVIEW_AUTO_ARCHIVE_DAY_MS = 24 * 60 * 60 * 1000;

export type PreviewBranchActivity = { lastDeploymentAt: Date | null; inProgress: boolean };

/** Shared policy for the branch list, settings preview, and locked cleanup page. */
export function classifyPreviewBranch(
  branch: { branchName: string | null; createdAt: Date },
  activity: PreviewBranchActivity,
  days: number,
  excluded: ReadonlySet<string>,
  now: Date
) {
  const archiveAt = new Date(
    (activity.lastDeploymentAt ?? branch.createdAt).getTime() + days * PREVIEW_AUTO_ARCHIVE_DAY_MS
  );
  if (branch.branchName !== null && excluded.has(branch.branchName)) {
    return { status: "protected" as const, archiveAt };
  }
  if (activity.inProgress) {
    return { status: "inProgress" as const, archiveAt };
  }
  return { status: archiveAt <= now ? ("ready" as const) : ("scheduled" as const), archiveAt };
}
