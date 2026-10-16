import { BuildServerMetadata, GitMeta } from "@trigger.dev/core/v3";

/** Short code of the deployment this one was redeployed from, if any. */
export function redeployOfShortCode(buildServerMetadata: unknown): string | null {
  const parsed = BuildServerMetadata.safeParse(buildServerMetadata);
  return parsed.success ? (parsed.data.redeployOf ?? null) : null;
}

export type RedeploySource =
  | { kind: "github"; commitSha: string; commitRef: string; git: GitMeta }
  | {
      kind: "artifact";
      artifactKey: string;
      configFilePath?: string;
      git?: GitMeta;
      fromBundle: boolean;
    };

/** Which build source a deployment can be rebuilt from. A bundle also needs its stored build env vars. */
export function resolveRedeploySource(deployment: {
  triggeredVia: string | null;
  git: unknown;
  buildServerMetadata: unknown;
  hasBuildEnvVars: boolean;
}): RedeploySource | null {
  const git = GitMeta.safeParse(deployment.git);

  if (deployment.triggeredVia === "git_integration:github") {
    if (git.success && git.data.commitSha && git.data.commitRef) {
      return {
        kind: "github",
        commitSha: git.data.commitSha,
        commitRef: git.data.commitRef,
        git: git.data,
      };
    }
    return null;
  }

  const metadata = BuildServerMetadata.safeParse(deployment.buildServerMetadata);
  if (metadata.success && metadata.data.isNativeBuild && metadata.data.artifactKey) {
    // The key prefix still marks a bundle when the metadata flag was lost to schema skew
    const fromBundle =
      metadata.data.fromBundle === true || metadata.data.artifactKey.startsWith("bundles/");
    if (fromBundle && !deployment.hasBuildEnvVars) return null;

    return {
      kind: "artifact",
      artifactKey: metadata.data.artifactKey,
      configFilePath: metadata.data.configFilePath,
      git: git.success ? git.data : undefined,
      fromBundle,
    };
  }

  return null;
}
