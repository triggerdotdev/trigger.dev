/**
 * The sentinel branch name the CLI/SDK sends for a `trigger dev` session that
 * isn't targeting a named dev branch. On the server the "root" development
 * environment is stored with `branchName: null`, so this value never matches a
 * real row — call sites translate it to "no branch" via {@link isDefaultDevBranch}.
 *
 * It's a wire value: any client (the CLI, a custom frontend) can send it in the
 * `x-trigger-branch` header, so the server must always interpret it, never
 * assume the CLI stripped it.
 */
export const DEFAULT_DEV_BRANCH = "default";

/**
 * Whether a branch name is the {@link DEFAULT_DEV_BRANCH} sentinel, i.e. it
 * refers to the root development environment rather than a named dev branch.
 */
export function isDefaultDevBranch(branchName: string | null | undefined): boolean {
  return branchName === DEFAULT_DEV_BRANCH;
}

export function isValidGitBranchName(branch: string): boolean {
  if (!branch) return false;

  if (/[ ~^:?*[\\]/.test(branch)) return false;

  for (let i = 0; i < branch.length; i++) {
    const code = branch.charCodeAt(i);
    if ((code >= 0 && code <= 31) || code === 127) return false;
  }

  if (branch.startsWith("/") || branch.endsWith("/")) return false;
  if (branch.includes("//")) return false;
  if (branch.includes("..")) return false;
  if (branch.includes("@{")) return false;
  if (branch.endsWith(".lock")) return false;

  return true;
}

export function sanitizeBranchName(ref: string | null | undefined): string | null {
  if (!ref) return null;
  if (ref.startsWith("refs/heads/")) return ref.substring("refs/heads/".length);
  if (ref.startsWith("refs/remotes/")) return ref.substring("refs/remotes/".length);
  if (ref.startsWith("refs/tags/")) return ref.substring("refs/tags/".length);
  if (ref.startsWith("refs/pull/")) return ref.substring("refs/pull/".length);
  if (ref.startsWith("refs/merge/")) return ref.substring("refs/merge/".length);
  if (ref.startsWith("refs/release/")) return ref.substring("refs/release/".length);
  if (ref.startsWith("refs/")) return null;

  return ref;
}
