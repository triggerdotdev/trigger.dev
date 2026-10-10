import { BuildServerMetadata, GitMeta } from "@trigger.dev/core/v3";

/** Short code of the deployment this one was redeployed from, if any. */
export function redeployOfShortCode(buildServerMetadata: unknown): string | null {
  const parsed = BuildServerMetadata.safeParse(buildServerMetadata);
  return parsed.success ? (parsed.data.redeployOf ?? null) : null;
}

export type RedeploySource =
  | { kind: "github"; commitSha: string; commitRef: string; git: GitMeta }
  | { kind: "artifact"; artifactKey: string; configFilePath?: string; git?: GitMeta };

/** Which build source a deployment can be rebuilt from. Bundle uploads are not redeployable yet. */
export function resolveRedeploySource(deployment: {
  triggeredVia: string | null;
  git: unknown;
  buildServerMetadata: unknown;
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
  if (
    metadata.success &&
    metadata.data.isNativeBuild &&
    metadata.data.artifactKey &&
    !metadata.data.fromBundle
  ) {
    return {
      kind: "artifact",
      artifactKey: metadata.data.artifactKey,
      configFilePath: metadata.data.configFilePath,
      git: git.success ? git.data : undefined,
    };
  }

  return null;
}
