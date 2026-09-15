import { createHash } from "node:crypto";
import { isDefaultDevBranch } from "@trigger.dev/core/v3/utils/gitBranch";

/**
 * Derives a filesystem-safe path segment for a dev branch, used to namespace
 * on-disk artifacts (lock files, the `.trigger/tmp` build tree, watchdog state)
 * so concurrent `trigger dev` sessions on different branches in the same project
 * don't clobber each other.
 *
 * Returns `undefined` for the default branch (or no branch) so callers keep
 * their original, branch-less paths for backwards compatibility.
 */
export function devBranchPathSegment(branch?: string): string | undefined {
  if (!branch || isDefaultDevBranch(branch)) {
    return undefined;
  }

  // Branch names can contain filesystem-unsafe characters (e.g. "/"), so sanitize.
  const sanitized = branch.replace(/[^a-zA-Z0-9-_]/g, "-");
  const branchHash = createHash("sha1").update(branch).digest("hex").slice(0, 8);
  return `${sanitized}-${branchHash}`;
}
