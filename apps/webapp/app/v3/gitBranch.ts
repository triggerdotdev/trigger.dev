export function isValidGitBranchName(branch: string): boolean {
  // Must not be empty
  if (!branch) return false;

  // Disallowed characters: space, ~, ^, :, ?, *, [, \
  if (/[ \~\^:\?\*\[\\]/.test(branch)) return false;

  // Disallow ASCII control characters (0-31) and DEL (127)
  for (let i = 0; i < branch.length; i++) {
    const code = branch.charCodeAt(i);
    if ((code >= 0 && code <= 31) || code === 127) return false;
  }

  // Cannot start or end with a slash
  if (branch.startsWith("/") || branch.endsWith("/")) return false;

  // Cannot have consecutive slashes
  if (branch.includes("//")) return false;

  // Cannot contain '..'
  if (branch.includes("..")) return false;

  // Cannot contain '@{'
  if (branch.includes("@{")) return false;

  // Cannot end with '.lock'
  if (branch.endsWith(".lock")) return false;

  return true;
}

export function sanitizeBranchName(ref: string): string | null {
  if (!ref) return null;
  if (ref.startsWith("refs/heads/")) return ref.substring("refs/heads/".length);
  if (ref.startsWith("refs/remotes/")) return ref.substring("refs/remotes/".length);
  if (ref.startsWith("refs/tags/")) return ref.substring("refs/tags/".length);
  if (ref.startsWith("refs/pull/")) return ref.substring("refs/pull/".length);
  if (ref.startsWith("refs/merge/")) return ref.substring("refs/merge/".length);
  if (ref.startsWith("refs/release/")) return ref.substring("refs/release/".length);
  //unknown ref format, so reject
  if (ref.startsWith("refs/")) return null;

  return ref;
}
