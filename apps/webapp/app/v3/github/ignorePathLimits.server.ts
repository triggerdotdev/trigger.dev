import { env } from "~/env.server";
import type { IgnorePathLimits } from "~/v3/github";

export function ignorePathLimits(): IgnorePathLimits {
  return {
    maxPaths: env.GITHUB_IGNORED_PATHS_LIMIT,
    maxLength: env.GITHUB_IGNORED_PATH_MAX_LENGTH,
  };
}
