import { env } from "~/env.server";
import type { IgnorePatternLimits } from "~/v3/github";

export function ignorePatternLimits(): IgnorePatternLimits {
  return {
    maxPatterns: env.GITHUB_IGNORED_PATHS_LIMIT,
    maxLength: env.GITHUB_IGNORED_PATH_MAX_LENGTH,
  };
}
