export function isValidGitBranchName(branch: string): boolean {
  if (!branch) return false;

  if (/[ \~\^:\?\*\[\\]/.test(branch)) return false;

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
