import type * as esbuild from "esbuild";

/**
 * Returns true if the passed value looks like an esbuild BuildFailure object
 */
export function isBuildFailure(err: unknown): err is esbuild.BuildFailure {
  return typeof err === "object" && err !== null && "errors" in err && "warnings" in err;
}
