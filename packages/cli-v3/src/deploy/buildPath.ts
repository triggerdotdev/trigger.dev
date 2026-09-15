import type { DeployBuildPath, GetDeploySettingsResponseBody } from "@trigger.dev/core/v3/schemas";
import { tryCatch } from "@trigger.dev/core/v3";

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

export type BuildPathFlags = {
  nativeBuildServer?: boolean;
  depotBuild?: boolean;
  localBuild?: boolean;
};

export type DeploySettingsResult =
  | { success: true; data: GetDeploySettingsResponseBody }
  | { success: false; statusCode?: number };

export type ResolvedBuildPath =
  | { buildPath: DeployBuildPath; from: "flag"; flag: string }
  | { buildPath: DeployBuildPath; from: "server" }
  | { buildPath: "depot"; from: "fallback"; silent: boolean; failure: unknown };

export async function resolveBuildPath(
  options: BuildPathFlags,
  fetchSettings: () => Promise<DeploySettingsResult>
): Promise<ResolvedBuildPath> {
  if (options.nativeBuildServer) {
    return { buildPath: "native", from: "flag", flag: "--native-build" };
  }

  if (options.localBuild) {
    return { buildPath: "depot", from: "flag", flag: "--local-build" };
  }

  if (options.depotBuild) {
    return { buildPath: "depot", from: "flag", flag: "--depot-build" };
  }

  const [error, result] = await tryCatch(fetchSettings());

  if (error || !result.success) {
    // A 404 is an older server without the endpoint; Depot is exactly what it expects.
    const silent = !error && !result.success && result.statusCode === 404;
    return { buildPath: "depot", from: "fallback", silent, failure: error ?? result };
  }

  return { buildPath: result.data.build_path, from: "server" };
}
