import type { DeployBuildPath } from "@trigger.dev/core/v3/schemas";

export type BuildPathOptions = {
  nativeBuildServer: boolean;
  localBundle: boolean;
  detach: boolean;
  dryRun: boolean;
};

export function nativeOnlyFlagError(options: BuildPathOptions): string | undefined {
  if (options.nativeBuildServer) return undefined;
  const flag = options.localBundle ? "--local-bundle" : options.detach ? "--detach" : undefined;
  return flag ? `${flag} requires --native-build.` : undefined;
}

export function applyBuildPathOptions(
  resolved: DeployBuildPath,
  options: BuildPathOptions
): DeployBuildPath {
  if (options.localBundle) {
    return "native_local_bundle";
  }

  // A plain native dry run would deploy for real, so bundle locally on the Depot path instead.
  if (options.dryRun && resolved === "native") {
    return "depot";
  }

  return resolved;
}
