import { GitMeta } from "../schemas/index.js";
import { getEnvVar } from "../utils/getEnv.js";

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
