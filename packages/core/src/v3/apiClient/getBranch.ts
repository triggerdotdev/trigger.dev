import { GitMeta } from "../schemas/index.js";
import { getEnvVar } from "../utils/getEnv.js";
import { isDefaultDevBranch } from "../utils/gitBranch.js";

export function getBranch({
  specified,
  gitMeta,
}: {
  specified?: string;
  gitMeta?: GitMeta;
}): string | undefined {
  if (specified) {
    return specified;
  }

  // not specified, so detect our variable from process.env
  const envVar = getEnvVar("TRIGGER_PREVIEW_BRANCH");
  if (envVar) {
    return envVar;
  }

  // detect the Vercel preview branch
  const vercelPreviewBranch = getEnvVar("VERCEL_GIT_COMMIT_REF");
  if (vercelPreviewBranch) {
    return vercelPreviewBranch;
  }

  // not specified, so detect from git metadata
  if (gitMeta?.commitRef) {
    return gitMeta.commitRef;
  }

  return undefined;
}

export function getDevBranch({ specified }: { specified?: string }): string | undefined {
  // For development we don't look at git/Vercel — only the flag and our env var.
  const branch = specified ?? getEnvVar("TRIGGER_DEV_BRANCH");

  // No branch and the "default" sentinel both mean the root dev env, which
  // carries no branch. Collapse to undefined so callers send no branch
  if (!branch || isDefaultDevBranch(branch)) {
    return undefined;
  }

  return branch;
}
