import { versionLabel } from "~/utils/versionLabel";

/**
 * Version choices for a replay: the current version first, then the other recent versions newest
 * first, each labelled by `versionLabel` ("20261117.3 · Current", "20261117.4 · Not promoted").
 * `versions` is newest first.
 */
export function replayVersionChoices(versions: string[], currentVersion: string | undefined) {
  return {
    currentLabel: currentVersion ? versionLabel(currentVersion, currentVersion) : "Current version",
    others: versions
      .filter((version) => version !== currentVersion)
      .map((version) => ({ value: version, label: versionLabel(version, currentVersion) })),
  };
}
