import { GitMeta } from "../schemas/index.js";
import { getEnvVar } from "../utils/getEnv.js";
import { DEFAULT_DEV_BRANCH } from "../utils/gitBranch.js";

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

export function getDevBranch({
  specified,
}: {
  specified?: string;
}): string {
  if (specified) {
    return specified;
  }

  // not specified, so detect our variable from process.env
  const envVar = getEnvVar("TRIGGER_DEV_BRANCH");
  if (envVar) {
    return envVar;
  }

  // For development we don't look at git/Vercel
  return DEFAULT_DEV_BRANCH;
}
