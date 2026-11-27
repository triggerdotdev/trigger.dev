import { compareDeploymentVersions } from "@trigger.dev/core/v3/isomorphic";

/**
 * Where a version stands against the environment's current version (the one new runs start on):
 * the current one, a newer one that was deployed but not promoted, or an older one.
 * In Development the current version is always the newest, so nothing is ever "not promoted".
 */
export type VersionStanding = "current" | "not-promoted" | "older";

export function versionStanding(
  version: string,
  currentVersion: string | undefined
): VersionStanding {
  if (!currentVersion) return "older";
  if (version === currentVersion) return "current";
  return compareDeploymentVersions(version, currentVersion) > 0 ? "not-promoted" : "older";
}

const VERSION_STANDING_LABEL: Record<VersionStanding, string | undefined> = {
  current: "Current",
  "not-promoted": "Not promoted",
  older: undefined,
};

/** One label for a version in every picker, dev and deployed: "20261117.3 · Current". */
export function versionLabel(version: string, currentVersion: string | undefined) {
  const tag = VERSION_STANDING_LABEL[versionStanding(version, currentVersion)];
  return tag ? `${version} · ${tag}` : version;
}

/** The hint under every disabled version picker in Development. */
export const DEV_VERSION_HINT = "In Development, runs use your newest version.";
