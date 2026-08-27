import type { DeployBuildPath } from "@trigger.dev/core/v3/schemas";

export type BuildPathOptions = {
  nativeBuildServer: boolean;
  localBundle: boolean;
  detach: boolean;
  dryRun: boolean;
};

/**
 * --local-bundle and --detach only exist on the native build server path, so they must be
 * paired with --native-build. Returns the error message for the first violation, if any.
 */
export function nativeOnlyFlagError(options: BuildPathOptions): string | undefined {
  if (options.nativeBuildServer) return undefined;
  const flag = options.localBundle ? "--local-bundle" : options.detach ? "--detach" : undefined;
  return flag ? `${flag} requires --native-build.` : undefined;
}

/**
 * Applies the modifiers to the resolved build path. --local-bundle turns the native path
 * into its local-bundle variant. A dry run never reaches the plain native path (it has no
 * dry-run mode and would deploy for real); it is bundled locally on the Depot path instead.
 * The local-bundle path handles dry runs itself.
 */
export function applyBuildPathOptions(
  resolved: DeployBuildPath,
  options: BuildPathOptions
): DeployBuildPath {
  if (options.localBundle) {
    return "native_local_bundle";
  }

  if (options.dryRun && resolved === "native") {
    return "depot";
  }

  return resolved;
}
