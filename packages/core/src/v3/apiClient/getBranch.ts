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

  // not specified, so detect from process.env
  const envVar = getEnvVar("TRIGGER_BRANCH");
  if (envVar) {
    return envVar;
  }

  // not specified, so detect from git metadata
  if (gitMeta?.commitRef) {
    return gitMeta.commitRef;
  }

  return undefined;
}
