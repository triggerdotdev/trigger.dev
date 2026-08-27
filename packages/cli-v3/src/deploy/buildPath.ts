import type { DeployBuildPath } from "@trigger.dev/core/v3/schemas";

export type BuildPathOptions = {
  localBundle: boolean;
  detach: boolean;
  dryRun: boolean;
};

/**
 * Applies the native-only modifiers to the resolved build path. --local-bundle and --detach
 * need the native build server: with it they apply, on Depot they throw. A dry run never
 * reaches the plain native path (it has no dry-run mode and would deploy for real); it is
 * bundled locally on the Depot path instead. The local-bundle path handles dry runs itself.
 */
export function applyBuildPathOptions(
  resolved: DeployBuildPath,
  options: BuildPathOptions
): DeployBuildPath {
  const nativeOnly = options.localBundle
    ? "--local-bundle"
    : options.detach
      ? "--detach"
      : undefined;

  if (nativeOnly && resolved === "depot") {
    throw new Error(
      `${nativeOnly} is only available with the native build server. Pass --native-build, or configure the native build path for this environment.`
    );
  }

  if (options.localBundle) {
    return "native_local_bundle";
  }

  if (options.dryRun && resolved === "native") {
    return "depot";
  }

  return resolved;
}
